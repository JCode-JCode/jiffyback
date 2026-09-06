export function securityHeaders(options = {}) {
  const contentTypeOptions = 'contentTypeOptions' in options ? options.contentTypeOptions : 'nosniff';
  const frameOptions = 'frameOptions' in options ? options.frameOptions : 'DENY';
  const referrerPolicy = 'referrerPolicy' in options ? options.referrerPolicy : 'no-referrer';
  const xssProtection = 'xssProtection' in options ? options.xssProtection : '0';
  const dnsPrefetchControl = 'dnsPrefetchControl' in options ? options.dnsPrefetchControl : 'off';
  const coop = 'crossOriginOpenerPolicy' in options ? options.crossOriginOpenerPolicy : 'same-origin';
  const corp = 'crossOriginResourcePolicy' in options ? options.crossOriginResourcePolicy : 'same-origin';
  const permissionsPolicy = options.permissionsPolicy ?? null;
  const contentSecurityPolicy = options.contentSecurityPolicy ?? null;
  const hsts = options.hsts ?? null;
  const hidePoweredBy = options.hidePoweredBy !== false;

  return (req, res, next) => {
    if (contentTypeOptions) res.setHeader('X-Content-Type-Options', contentTypeOptions);
    if (frameOptions) res.setHeader('X-Frame-Options', frameOptions);
    if (referrerPolicy) res.setHeader('Referrer-Policy', referrerPolicy);
    if (xssProtection !== null && xssProtection !== false) res.setHeader('X-XSS-Protection', xssProtection);
    if (dnsPrefetchControl) res.setHeader('X-DNS-Prefetch-Control', dnsPrefetchControl);
    if (coop) res.setHeader('Cross-Origin-Opener-Policy', coop);
    if (corp) res.setHeader('Cross-Origin-Resource-Policy', corp);
    if (permissionsPolicy) res.setHeader('Permissions-Policy', permissionsPolicy);
    if (contentSecurityPolicy) res.setHeader('Content-Security-Policy', contentSecurityPolicy);

    if (hsts && req.secure) {
      const maxAge = hsts.maxAge ?? 15_552_000;
      let value = `max-age=${maxAge}`;
      if (hsts.includeSubDomains !== false) value += '; includeSubDomains';
      if (hsts.preload) value += '; preload';
      res.setHeader('Strict-Transport-Security', value);
    }

    if (hidePoweredBy) res.removeHeader('X-Powered-By');

    next();
  };
}
