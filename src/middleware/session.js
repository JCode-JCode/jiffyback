import crypto from 'crypto';
import { sign, unsign } from './cookieParser.js';

const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 50_000;

export class MemorySessionStore {
  constructor(options = {}) {
    this.sessions = new Map();
    this._interval = null;
    this._maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  get(id) {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    this.sessions.delete(id);
    this.sessions.set(id, entry);
    return entry.data;
  }

  set(id, data, maxAge) {
    if (this.sessions.has(id)) this.sessions.delete(id);
    this.sessions.set(id, { data, expiresAt: Date.now() + maxAge });

    if (this.sessions.size > this._maxSessions) {
      const lruId = this.sessions.keys().next().value;
      this.sessions.delete(lruId);
    }
  }

  destroy(id) {
    this.sessions.delete(id);
  }

  startCleanup(maxAge) {
    if (this._interval) return;
    const intervalMs = Math.min(Math.max(maxAge, 60_000), 6 * 60 * 60 * 1000);
    this._interval = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.sessions) {
        if (entry.expiresAt <= now) this.sessions.delete(id);
      }
    }, intervalMs).unref();
  }

  stopCleanup() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }
}

function generateId() {
  return crypto.randomBytes(32).toString('base64url');
}

export function session(options = {}) {
  if (!options.secret) {
    throw new TypeError('session(): options.secret is required (used to sign the session-id cookie)');
  }
  const secret = options.secret;
  const cookieName = options.cookieName || 'jsid';
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  const rolling = options.rolling !== false;
  const resave = options.resave === true;
  const store = options.store || new MemorySessionStore({ maxSessions: options.maxSessions });
  const cookieOptions = { path: '/', sameSite: 'Lax', secure: false, ...(options.cookie || {}) };

  if (typeof store.startCleanup === 'function') store.startCleanup(maxAge);

  return async (req, res, next) => {
    const raw = req.cookies ? req.cookies[cookieName] : undefined;
    const unsignedId = typeof raw === 'string' ? unsign(raw, secret) : false;

    let id = unsignedId || undefined;
    let data;
    let isNew = false;

    if (id) {
      try {
        data = await store.get(id);
      } catch (err) {
        return next(err);
      }
    }
    if (!id || data === undefined) {
      id = generateId();
      data = {};
      isNew = true;
    }

    const state = { id, isNew, idChanged: false, modified: false, destroyed: false, previousId: null };

    const sessionProxy = new Proxy(data, {
      set(target, prop, value) {
        target[prop] = value;
        state.modified = true;
        return true;
      },
      deleteProperty(target, prop) {
        delete target[prop];
        state.modified = true;
        return true;
      },
    });

    Object.defineProperties(data, {
      regenerate: {
        enumerable: false,
        value: () => {
          state.previousId = state.id;
          state.id = generateId();
          state.idChanged = true;
          state.modified = true;
          state.isNew = false;
        },
      },
      destroy: {
        enumerable: false,
        value: () => {
          state.destroyed = true;
        },
      },
      touch: {
        enumerable: false,
        value: () => {
          state.modified = true;
        },
      },
    });

    req.session = sessionProxy;

    res.on('finish', () => void persist());
    res.on('close', () => void persist());

    let persisted = false;
    async function persist() {
      if (persisted) return;
      persisted = true;

      try {
        if (state.destroyed) {
          await store.destroy(state.id);
          if (!state.isNew) res.clearCookie(cookieName, cookieOptions);
          return;
        }

        if (state.previousId) {
          Promise.resolve(store.destroy(state.previousId)).catch(() => {});
        }

        const shouldPersist = state.isNew || state.idChanged || state.modified || resave || rolling;
        if (shouldPersist) {
          const snapshot = { ...data };
          await store.set(state.id, snapshot, maxAge);
        }

        const shouldSetCookie = state.isNew || state.idChanged || rolling;
        if (shouldSetCookie) {
          res.cookie(cookieName, sign(state.id, secret), {
            ...cookieOptions,
            httpOnly: true,
            maxAge: Math.floor(maxAge / 1000),
          });
        }
      } catch (err) {
        console.error('[jiffyback] session store error while saving:', err);
      }
    }

    next();
  };
}
