import fs from 'fs';
import path from 'path';
import { getMimeType } from './utils/mime.js';

const VALID_COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function enhanceResponse(res) {
  res._pendingAsync = 0;

  res.status = function (code) {
    this.statusCode = code;
    return this;
  };

  res.set = function (name, value) {
    if (typeof name === 'object') {
      for (const key of Object.keys(name)) this.setHeader(key, name[key]);
    } else {
      this.setHeader(name, value);
    }
    return this;
  };
  res.header = res.set;

  res.get = function (name) {
    return this.getHeader(name);
  };

  res.type = function (type) {
    const withCharset = type.includes('/') ? type : getMimeType(`.${type}`);
    this.setHeader('Content-Type', withCharset);
    return this;
  };

  function endBody(payload, byteLength) {
    if (res.req?.method === 'HEAD') {
      if (!res.getHeader('Content-Length')) res.setHeader('Content-Length', byteLength);
      res.end();
    } else {
      res.end(payload);
    }
  }

  res.json = function (data) {
    if (!this.getHeader('Content-Type')) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    const payload = JSON.stringify(data);
    endBody(payload, Buffer.byteLength(payload));
  };

  res.send = function (body) {
    if (typeof body === 'string') {
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
      endBody(body, Buffer.byteLength(body));
    } else if (Buffer.isBuffer(body)) {
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/octet-stream');
      }
      endBody(body, body.length);
    } else if (body === undefined || body === null) {
      this.end();
    } else if (typeof body === 'object') {
      this.json(body);
    } else {
      const str = String(body);
      endBody(str, Buffer.byteLength(str));
    }
  };

  const UNSAFE_HEADER_VALUE = /[\r\n]/;
  res.redirect = function (url, statusCode = 302) {
    if (UNSAFE_HEADER_VALUE.test(String(url))) {
      throw new TypeError('res.redirect: url must not contain CR/LF characters (possible header injection)');
    }
    this.statusCode = statusCode;
    this.setHeader('Location', url);
    this.end();
  };

  res.cookie = function (name, value, options = {}) {
    if (!VALID_COOKIE_NAME.test(String(name))) {
      throw new TypeError(`res.cookie: invalid cookie name "${name}"`);
    }

    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
    if (options.domain) parts.push(`Domain=${options.domain}`);
    parts.push(`Path=${options.path || '/'}`);
    if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    if (options.secure) parts.push('Secure');
    if (options.httpOnly !== false) parts.push('HttpOnly');
    parts.push(`SameSite=${options.sameSite || 'Lax'}`);

    const existing = this.getHeader('Set-Cookie');
    const newCookie = parts.join('; ');
    if (existing) {
      this.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, newCookie] : [existing, newCookie]);
    } else {
      this.setHeader('Set-Cookie', newCookie);
    }
    return this;
  };

  res.clearCookie = function (name, options = {}) {
    return this.cookie(name, '', { ...options, maxAge: 0, expires: new Date(0) });
  };

  res.sendFile = function (absolutePath, options = {}) {
    const self = this;
    self._pendingAsync = (self._pendingAsync || 0) + 1;
    fs.stat(absolutePath, (err, stats) => {
      self._pendingAsync--;
      if (err || !stats.isFile()) {
        if (!self.headersSent) self.status(404).send('File not found');
        return;
      }

      const ext = path.extname(absolutePath);
      const etag = `"${stats.size}-${stats.mtimeMs}"`;
      self.setHeader('Content-Type', getMimeType(ext));
      self.setHeader('ETag', etag);
      self.setHeader('Cache-Control', options.cacheControl || 'public, max-age=3600');
      self.setHeader('Accept-Ranges', 'bytes');
      self.setHeader('Last-Modified', stats.mtime.toUTCString());
      if (options.contentDisposition) {
        self.setHeader('Content-Disposition', options.contentDisposition);
      }

      const ifNoneMatch = self.req?.headers?.['if-none-match'];
      if (ifNoneMatch === etag) {
        self.statusCode = 304;
        self.end();
        return;
      }

      const range = self.req?.headers?.range;
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        if (match) {
          const hasStart = match[1] !== '';
          const hasEnd = match[2] !== '';
          let start;
          let end;
          if (!hasStart && hasEnd) {
            const suffixLength = parseInt(match[2], 10);
            start = Math.max(0, stats.size - suffixLength);
            end = stats.size - 1;
          } else {
            start = hasStart ? parseInt(match[1], 10) : 0;
            end = hasEnd ? parseInt(match[2], 10) : stats.size - 1;
          }
          if (start >= stats.size || end >= stats.size || start > end) {
            self.statusCode = 416;
            self.setHeader('Content-Range', `bytes */${stats.size}`);
            self.end();
            return;
          }
          self.statusCode = 206;
          self.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
          self.setHeader('Content-Length', end - start + 1);
          fs.createReadStream(absolutePath, { start, end }).pipe(self);
          return;
        }
      }

      self.setHeader('Content-Length', stats.size);
      if (self.req?.method === 'HEAD') {
        self.end();
        return;
      }
      fs.createReadStream(absolutePath).pipe(self);
    });
  };

  res.download = function (absolutePath, filename) {
    const name = filename || path.basename(absolutePath);
    const safeName = String(name).replace(/[\\"]/g, '\\$&');
    this.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    this.sendFile(absolutePath);
  };

  res.render = function (viewName, data = {}, renderOptions = {}) {
    const self = this;
    self._pendingAsync = (self._pendingAsync || 0) + 1;
    const fail = (err) => {
      self._pendingAsync--;
      if (typeof self.next === 'function') {
        self.next(err);
      } else if (!self.headersSent) {
        console.error('[jiffyback] res.render error:', err);
        self.status(500).json({ error: 'Internal Server Error' });
      }
    };

    const engine = self.req?.app?.viewEngine;
    if (!engine) {
      fail(new Error('res.render: no view engine configured - pass `views: { dir: "..." }` to createServer()'));
      return Promise.resolve();
    }

    return engine.render(viewName, data, renderOptions).then((html) => {
      self._pendingAsync--;
      if (self.headersSent) return;
      self.setHeader('Content-Type', 'text/html; charset=utf-8');
      self.send(html);
    }, fail);
  };

  return res;
}
