import { parseURL } from './utils/urlParser.js';

function normalizeIp(addr) {
  return typeof addr === 'string' && addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function resolveClientIp(xff, remoteAddress, trust) {
  const chain = xff.split(',').map((s) => s.trim()).filter(Boolean);
  if (chain.length === 0) return remoteAddress;

  if (typeof trust === 'number') {
    const idx = chain.length - trust;
    return idx >= 0 && idx < chain.length ? chain[idx] : chain[0];
  }

  if (Array.isArray(trust)) {
    const normalizedTrust = trust.map(normalizeIp);
    if (!remoteAddress || !normalizedTrust.includes(normalizeIp(remoteAddress))) return remoteAddress;
    let i = chain.length - 1;
    while (i >= 0 && normalizedTrust.includes(normalizeIp(chain[i]))) i--;
    return i >= 0 ? chain[i] : chain[0];
  }

  return chain[0];
}

function parseQuery(queryString) {
  const query = new Map();
  for (const [key, value] of new URLSearchParams(queryString)) {
    if (!query.has(key)) {
      query.set(key, value);
    } else {
      const existing = query.get(key);
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query.set(key, [existing, value]);
      }
    }
  }
  return Object.fromEntries(query);
}

export function enhanceRequest(req) {
  const { pathname, queryString } = parseURL(req.url);
  req.pathname = pathname;
  req.query = parseQuery(queryString);
  req.params = {};
  req.body = null;
  req.cookies = {};

  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach((c) => {
      const idx = c.indexOf('=');
      if (idx === -1) return;
      const name = c.slice(0, idx).trim();
      const value = c.slice(idx + 1).trim();
      if (name) {
        try {
          req.cookies[name] = decodeURIComponent(value);
        } catch {
          req.cookies[name] = value;
        }
      }
    });
  }

  req.get = function (name) {
    return this.headers[name.toLowerCase()];
  };
  req.header = req.get;

  req.is = function (type) {
    const contentType = this.headers['content-type'] || '';
    return contentType.toLowerCase().includes(type.toLowerCase());
  };

  Object.defineProperty(req, 'secure', {
    configurable: true,
    get() {
      if (this.socket && this.socket.encrypted) return true;
      if (this.app && this.app.trustProxy && this.headers['x-forwarded-proto']) {
        return this.headers['x-forwarded-proto'].split(',')[0].trim() === 'https';
      }
      return false;
    },
  });

  Object.defineProperty(req, 'ip', {
    configurable: true,
    get() {
      const trust = this.app && this.app.trustProxy;
      if (trust && this.headers['x-forwarded-for']) {
        return resolveClientIp(this.headers['x-forwarded-for'], this.socket?.remoteAddress, trust);
      }
      return this.socket?.remoteAddress;
    },
  });

  return req;
}
