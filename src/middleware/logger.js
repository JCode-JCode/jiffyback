const COLORS = { 2: '32', 3: '36', 4: '33', 5: '31' };

function stripControlChars(str) {
  return String(str).replace(/[\x00-\x1f\x7f]/g, '');
}

export function logger(options = {}) {
  const enabled = options.enabled === true;
  const useColor = options.color !== false;

  return (req, res, next) => {
    if (!enabled) return next();

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode;
      const safePathname = stripControlChars(req.pathname);
      const line = `${req.method} ${safePathname} ${status} - ${durationMs.toFixed(1)}ms`;

      if (useColor) {
        const code = COLORS[Math.floor(status / 100)] || '37';
        console.log(`\x1b[${code}m${line}\x1b[0m`);
      } else {
        console.log(line);
      }
    });

    next();
  };
}
