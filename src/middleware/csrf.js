import crypto from 'crypto';

export function csrf(options = {}) {
  const cookieName = options.cookieName || '_csrf';
  const headerName = (options.headerName || 'x-csrf-token').toLowerCase();
  const bodyField = options.bodyField || '_csrf';
  const ignoreMethods = new Set(options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS']);
  const cookieOptions = { sameSite: 'Strict', httpOnly: false, ...(options.cookie || {}) };

  return (req, res, next) => {
    let token = req.cookies ? req.cookies[cookieName] : undefined;
    if (!token || typeof token !== 'string') {
      token = crypto.randomBytes(32).toString('base64url');
      res.cookie(cookieName, token, cookieOptions);
    }

    req.csrfToken = () => token;

    if (ignoreMethods.has(req.method)) return next();

    const provided = req.headers[headerName] || (req.body && typeof req.body === 'object' ? req.body[bodyField] : undefined);

    if (!provided || !timingSafeEqualStrings(String(provided), token)) {
      res.status(403).json({ error: 'Invalid or missing CSRF token' });
      return;
    }

    next();
  };
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
