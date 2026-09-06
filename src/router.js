const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePath(routePath) {
  const paramNames = [];
  let wildcardCount = 0;
  let pattern = routePath
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) {
        const optional = segment.endsWith('?');
        const name = segment.slice(1, optional ? -1 : undefined);
        paramNames.push(name);
        return optional ? '(?:/([^/]+))?' : '/([^/]+)';
      }
      if (segment === '*') {
        wildcardCount++;
        paramNames.push(wildcardCount === 1 ? 'wildcard' : `wildcard${wildcardCount}`);
        return '/(.*)';
      }
      return segment === '' ? '' : '/' + escapeRegex(segment);
    })
    .join('');

  if (pattern === '') pattern = '/';
  pattern = pattern.replace(/^\/(?:\/)/, '/');
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

export class Router {
  constructor() {
    this.stack = [];
    this.isJiffyRouter = true;
  }

  use(mountPath, handler) {
    if (typeof mountPath === 'function' || mountPath?.isJiffyRouter) {
      handler = mountPath;
      mountPath = '/';
    }

    if (handler?.isJiffyRouter) {
      this.stack.push({ type: 'mount', path: normalizeMount(mountPath), router: handler });
      return this;
    }

    if (typeof handler !== 'function') {
      throw new TypeError('use() requires a middleware function or a Router instance');
    }

    if (handler.length >= 4) {
      this.stack.push({ type: 'error', path: normalizeMount(mountPath), handler });
    } else {
      this.stack.push({ type: 'middleware', path: normalizeMount(mountPath), handler });
    }
    return this;
  }

  _addRoute(method, routePath, ...handlers) {
    const { regex, paramNames } = compilePath(routePath);
    this.stack.push({
      type: 'route',
      method: method.toUpperCase(),
      regex,
      paramNames,
      handlers,
    });
    return this;
  }

  get(p, ...h)     { return this._addRoute('GET', p, ...h); }
  head(p, ...h)    { return this._addRoute('HEAD', p, ...h); }
  post(p, ...h)    { return this._addRoute('POST', p, ...h); }
  put(p, ...h)     { return this._addRoute('PUT', p, ...h); }
  delete(p, ...h)  { return this._addRoute('DELETE', p, ...h); }
  patch(p, ...h)   { return this._addRoute('PATCH', p, ...h); }
  options(p, ...h) { return this._addRoute('OPTIONS', p, ...h); }
  all(p, ...h) {
    for (const m of METHODS) this._addRoute(m, p, ...h);
    return this;
  }

  handle(req, res, doneCallback) {
    const stack = this.stack;
    let idx = 0;
    let handled = false;

    const next = (err) => {
      if (handled || res.writableEnded) return;
      if (idx >= stack.length) {
        handled = true;
        return doneCallback(err);
      }
      const layer = stack[idx++];

      if (err) {
        if (layer.type === 'error' && pathMatchesPrefix(req.pathname, layer.path)) {
          try {
            return layer.handler(err, req, res, next);
          } catch (e) {
            return next(e);
          }
        }
        return next(err);
      }

      if (layer.type === 'error') return next();

      if (layer.type === 'mount') {
        if (!pathMatchesPrefix(req.pathname, layer.path)) return next();
        const originalPathname = req.pathname;
        const stripped = originalPathname.slice(layer.path.length) || '/';
        req.pathname = stripped.startsWith('/') ? stripped : '/' + stripped;
        layer.router.handle(req, res, (mountErr) => {
          req.pathname = originalPathname;
          next(mountErr);
        });
        return;
      }

      if (layer.type === 'middleware') {
        if (!pathMatchesPrefix(req.pathname, layer.path)) return next();
        res.next = next;
        try {
          const maybePromise = layer.handler(req, res, next);
          const isAsync = maybePromise && typeof maybePromise.catch === 'function';
          if (isAsync) {
            maybePromise.catch(next);
          }
          if (!isAsync && layer.handler.length < 3 && !res.writableEnded && !res._pendingAsync) {
            next();
          }
        } catch (e) {
          next(e);
        }
        return;
      }

      if (layer.type === 'route') {
        const methodMatches = layer.method === req.method || (req.method === 'HEAD' && layer.method === 'GET');
        if (!methodMatches) return next();
        const match = req.pathname.match(layer.regex);
        if (!match) return next();

        const params = {};
        try {
          layer.paramNames.forEach((name, i) => {
            params[name] = match[i + 1] !== undefined ? decodeURIComponent(match[i + 1]) : undefined;
          });
        } catch {
          res.status(400).json({ error: 'Bad Request', message: 'Invalid encoding in route parameter' });
          return;
        }
        req.params = params;

        let hIdx = 0;
        const runHandler = (routeErr) => {
          if (res.writableEnded) return;
          if (routeErr) return next(routeErr);
          if (hIdx >= layer.handlers.length) return next();
          const h = layer.handlers[hIdx++];
          res.next = runHandler;
          try {
            const maybePromise = h(req, res, runHandler);
            const isAsync = maybePromise && typeof maybePromise.catch === 'function';
            if (isAsync) {
              maybePromise.catch(runHandler);
            }
            if (!isAsync && h.length < 3 && !res.writableEnded && !res._pendingAsync) {
              runHandler();
            }
          } catch (e) {
            runHandler(e);
          }
        };
        runHandler();
        return;
      }

      next();
    };

    next();
  }
}

function normalizeMount(p) {
  if (!p || p === '/') return '/';
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

function pathMatchesPrefix(pathname, prefix) {
  if (prefix === '/') return true;
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix + '/');
}
