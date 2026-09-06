import zlib from 'zlib';
import { promisify } from 'util';

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);
const deflateAsync = promisify(zlib.deflate);

export function compression(options = {}) {
  const threshold = options.threshold ?? 1024;
  const maxSize = options.maxSize ?? 2 * 1024 * 1024;
  const brotliQuality = options.brotliQuality ?? 4;

  return (req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const originalEnd = res.end.bind(res);

    res.end = function (chunk, encoding) {
      if (!chunk || typeof chunk === 'function' || res.getHeader('Content-Encoding') || res.headersSent) {
        return originalEnd(chunk, encoding);
      }

      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      const contentType = String(res.getHeader('Content-Type') || '');

      const isCompressibleType = /json|html|text|javascript|xml|svg/i.test(contentType) || contentType === '';
      if (buf.length < threshold || buf.length > maxSize || !isCompressibleType) {
        return originalEnd(buf);
      }

      let encodingName;
      let compressAsync;
      let compressOptions;
      if (/\bbr\b/.test(acceptEncoding)) {
        encodingName = 'br';
        compressAsync = brotliCompressAsync;
        compressOptions = {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        };
      } else if (/gzip/.test(acceptEncoding)) {
        encodingName = 'gzip';
        compressAsync = gzipAsync;
        compressOptions = { level: zlib.constants.Z_DEFAULT_COMPRESSION };
      } else if (/deflate/.test(acceptEncoding)) {
        encodingName = 'deflate';
        compressAsync = deflateAsync;
        compressOptions = { level: zlib.constants.Z_DEFAULT_COMPRESSION };
      } else {
        return originalEnd(buf);
      }

      res._pendingAsync = (res._pendingAsync || 0) + 1;
      compressAsync(buf, compressOptions).then(
        (compressed) => {
          res._pendingAsync--;
          if (res.writableEnded) return;
          res.setHeader('Content-Encoding', encodingName);
          res.setHeader('Vary', 'Accept-Encoding');
          res.removeHeader('Content-Length');
          originalEnd(compressed);
        },
        () => {
          res._pendingAsync--;
          if (!res.writableEnded) originalEnd(buf);
        },
      );

      return res;
    };

    next();
  };
}
