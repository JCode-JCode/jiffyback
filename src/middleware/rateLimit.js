const DEFAULT_MAX_KEYS = 50_000;

export class MemoryStore {
  constructor(options = {}) {
    this.hits = new Map();
    this._interval = null;
    this._maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  increment(key, windowMs) {
    const now = Date.now();
    let entry = this.hits.get(key);

    if (!entry || entry.windowEnd <= now) {
      const prevCount = entry && now < entry.windowEnd + windowMs ? entry.count : 0;
      entry = { count: 0, windowEnd: now + windowMs, prevCount };
    } else {
      this.hits.delete(key);
    }

    entry.count++;
    this.hits.set(key, entry);

    if (this.hits.size > this._maxKeys) {
      const lruKey = this.hits.keys().next().value;
      this.hits.delete(lruKey);
    }

    const elapsed = windowMs - (entry.windowEnd - now);
    const weight = Math.max(0, (windowMs - elapsed) / windowMs);
    const count = Math.round(entry.prevCount * weight + entry.count);

    return { count, resetAt: entry.windowEnd };
  }

  startCleanup(windowMs) {
    if (this._interval) return;
    this._interval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.hits) {
        if (entry.windowEnd + windowMs <= now) this.hits.delete(key);
      }
    }, windowMs).unref();
  }

  stopCleanup() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }
}

export function rateLimit(options = {}) {
  const windowMs = options.windowMs || 60_000;
  const max = options.max || 100;
  const keyFn = options.keyGenerator || ((req) => req.ip || 'unknown');
  const message = options.message || 'Too Many Requests';
  const store = options.store || new MemoryStore({ maxKeys: options.maxKeys });

  if (typeof store.startCleanup === 'function') store.startCleanup(windowMs);

  return async (req, res, next) => {
    const key = keyFn(req);

    let result;
    try {
      result = await store.increment(key, windowMs);
    } catch (err) {
      return next(err);
    }

    const { count, resetAt } = result;
    const remaining = Math.max(0, max - count);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000));

    if (count > max) {
      res.setHeader('Retry-After', Math.ceil((resetAt - Date.now()) / 1000));
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}
