import fs from 'fs';
import path from 'path';
import { safeJoin } from '../utils/safePath.js';

export function serveStatic(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const indexFile = options.index || 'index.html';
  const allowDotfiles = options.dotfiles === 'allow';
  const attachmentExtensions = new Set((options.attachmentExtensions || []).map((e) => e.toLowerCase()));

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    if (!allowDotfiles && req.pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '')) {
      return next();
    }

    let filePath = safeJoin(root, req.pathname);
    if (!filePath) {
      res.status(400).send('Bad Request');
      return;
    }

    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) {
        const indexPath = safeJoin(root, path.posix.join(req.pathname, indexFile));
        if (!indexPath) return next();
        try {
          await fs.promises.access(indexPath, fs.constants.F_OK);
        } catch {
          return next();
        }
        filePath = indexPath;
      }
    } catch {
      return next();
    }

    res.sendFile(filePath, {
      cacheControl: options.cacheControl,
      contentDisposition: attachmentExtensions.has(path.extname(filePath).toLowerCase()) ? 'attachment' : undefined,
    });
  };
}
