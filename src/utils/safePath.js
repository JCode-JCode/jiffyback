import path from 'path';

export function safeJoin(rootPath, requestedPath) {
  const root = path.resolve(rootPath);

  if (requestedPath.includes('\0')) return null;

  const target = path.resolve(root, `.${path.sep}${requestedPath}`);

  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }

  return target;
}

export function sanitizeFilename(filename) {
  const base = path.basename(String(filename ?? '').replace(/\0/g, ''));
  return base === '' || base === '.' || base === '..' ? 'file' : base;
}
