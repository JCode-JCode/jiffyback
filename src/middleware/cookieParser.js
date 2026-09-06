import crypto from 'crypto';

export function cookieParser(secret) {
  return (req, res, next) => {
    req.signedCookies = {};
    if (secret) {
      for (const [name, value] of Object.entries(req.cookies)) {
        if (typeof value === 'string' && value.startsWith('s:')) {
          const verified = unsign(value.slice(2), secret);
          if (verified !== false) {
            req.signedCookies[name] = verified;
            delete req.cookies[name];
          }
        }
      }
    }
    if (next) next();
  };
}

export function sign(value, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${hmac}`;
}

export function unsign(signed, secret) {
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return false;
  const value = signed.slice(0, idx);
  const expected = sign(value, secret);
  const signedBuf = Buffer.from(signed);
  const expectedBuf = Buffer.from(expected);
  if (signedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(signedBuf, expectedBuf) ? value : false;
}
