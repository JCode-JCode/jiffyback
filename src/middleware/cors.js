export function cors(options = {}) {
  const origin = options.origin ?? '*';
  const methods = options.methods || 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS';
  const allowedHeaders = options.allowedHeaders || 'Content-Type,Authorization';
  const credentials = Boolean(options.credentials);
  const maxAge = options.maxAge;

  return (req, res, next) => {
    const reqOrigin = req.headers.origin;

    let allowOrigin;
    let varyOrigin = false;

    if (typeof origin === 'function') {
      allowOrigin = origin(reqOrigin) || '';
      varyOrigin = true;
    } else if (Array.isArray(origin)) {
      varyOrigin = true;
      if (reqOrigin && origin.includes(reqOrigin)) {
        allowOrigin = reqOrigin;
      }
    } else {
      allowOrigin = origin;
    }

    if (credentials && allowOrigin === '*') {
      if (reqOrigin) {
        allowOrigin = reqOrigin;
        varyOrigin = true;
      } else {
        allowOrigin = undefined;
      }
    }

    if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    if (varyOrigin) res.setHeader('Vary', 'Origin');
    if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);

    if (req.method === 'OPTIONS') {
      if (maxAge != null) res.setHeader('Access-Control-Max-Age', String(maxAge));
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}
