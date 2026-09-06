import http from 'http';
import https from 'https';
import { enhanceRequest } from './request.js';
import { enhanceResponse } from './response.js';
import { Router } from './router.js';
import { attachWebSocket } from './websocket.js';
import { createViewEngine } from './view.js';

export class Server {
  constructor(options = {}) {
    this.options = options;
    this.trustProxy = options.trustProxy ?? false;
    this.router = new Router();
    this.server = null;
    this.wsRoutes = new Map();
    this.errorHandler = defaultErrorHandler;
    this.notFoundHandler = defaultNotFoundHandler;
    this.viewEngine = options.views ? createViewEngine(options.views) : null;
  }

  use(...args)     { this.router.use(...args); return this; }
  get(...args)     { this.router.get(...args); return this; }
  head(...args)    { this.router.head(...args); return this; }
  post(...args)    { this.router.post(...args); return this; }
  put(...args)     { this.router.put(...args); return this; }
  delete(...args)  { this.router.delete(...args); return this; }
  patch(...args)   { this.router.patch(...args); return this; }
  options(...args) { this.router.options(...args); return this; }
  all(...args)     { this.router.all(...args); return this; }

  onError(handler) { this.errorHandler = handler; return this; }
  onNotFound(handler) { this.notFoundHandler = handler; return this; }

  ws(path, handler) {
    this.wsRoutes.set(path, handler);
    return this;
  }

  _requestListener(req, res) {
    req.app = this;
    enhanceRequest(req);
    enhanceResponse(res);

    try {
      this.router.handle(req, res, (err) => {
        if (res.writableEnded) return;
        if (err) {
          this._handleError(err, req, res);
        } else {
          this.notFoundHandler(req, res);
        }
      });
    } catch (err) {
      if (!res.writableEnded) this._handleError(err, req, res);
    }
  }

  _handleError(err, req, res) {
    try {
      this.errorHandler(err, req, res);
    } catch (fatal) {
      console.error('[jiffyback] fatal error inside errorHandler:', fatal);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  }

  listen(port, hostOrCallback, maybeCallback) {
    const host = typeof hostOrCallback === 'string' ? hostOrCallback : undefined;
    const callback = typeof hostOrCallback === 'function' ? hostOrCallback : maybeCallback;

    const listener = this._requestListener.bind(this);

    this.server = this.options.https
      ? https.createServer(this.options.https, listener)
      : http.createServer(listener);

    const timeouts = this.options.timeouts || {};
    this.server.headersTimeout = timeouts.headersTimeout ?? 0;
    this.server.requestTimeout = timeouts.requestTimeout ?? 0;
    this.server.keepAliveTimeout = timeouts.keepAliveTimeout ?? 5_000;

    if (this.wsRoutes.size > 0) {
      attachWebSocket(this.server, this.wsRoutes, this.options.websocket || {});
    }

    if (host) {
      this.server.listen(port, host, callback);
    } else {
      this.server.listen(port, callback);
    }
    return this.server;
  }

  close(callback) {
    if (this.server) this.server.close(callback);
    else if (callback) callback();
  }
}

function defaultNotFoundHandler(req, res) {
  res.status(404).json({ error: 'Not Found', path: req.pathname });
}

function defaultErrorHandler(err, req, res) {
  console.error('[jiffyback] unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}

export function createServer(options) {
  return new Server(options);
}
