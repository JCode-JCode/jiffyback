export function parseURL(url) {
  const [rawPath, queryString = ''] = url.split('?');

  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    pathname = rawPath;
  }

  pathname = normalizePathname(pathname);

  return { pathname, queryString };
}

function normalizePathname(pathname) {
  let result = pathname.replace(/\/{2,}/g, '/');
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}
