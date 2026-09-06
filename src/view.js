import fs from 'fs';
import path from 'path';
import { safeJoin } from './utils/safePath.js';

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function toEntries(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (typeof value[Symbol.iterator] === 'function') return [...value].map((v, i) => [i, v]);
  if (typeof value === 'object') return Object.entries(value);
  return [];
}

function parseEach(inner, filename) {
  const rest = inner.slice(5).trim();
  const inIdx = rest.indexOf(' in ');
  if (inIdx === -1) {
    throw new Error(
      `jiffyback view "${filename}": invalid {{each}} - expected {{each item in items}} or ` +
        `{{each item, index in items}}, got {{${inner}}}`
    );
  }
  const left = rest.slice(0, inIdx).trim();
  const iterableExpr = rest.slice(inIdx + 4).trim();
  if (!iterableExpr) throw new Error(`jiffyback view "${filename}": {{each}} is missing the iterable after "in"`);

  let itemName = left;
  let indexName = null;
  if (left.includes(',')) {
    const parts = left.split(',').map((s) => s.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`jiffyback view "${filename}": invalid {{each}} item/index list "${left}"`);
    }
    [itemName, indexName] = parts;
  }
  for (const name of [itemName, indexName]) {
    if (name !== null && !IDENT_RE.test(name)) {
      throw new Error(`jiffyback view "${filename}": "${name}" in {{each}} is not a valid identifier`);
    }
  }
  return { itemName, indexName, iterableExpr };
}

function parseInclude(inner, filename) {
  const rest = inner.slice(8).trim();
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") {
    throw new Error(`jiffyback view "${filename}": {{include}} must start with a quoted partial name, got {{${inner}}}`);
  }
  const closeIdx = rest.indexOf(quote, 1);
  if (closeIdx === -1) throw new Error(`jiffyback view "${filename}": unterminated string in {{include}}`);
  const partial = rest.slice(1, closeIdx);
  const dataExprRaw = rest.slice(closeIdx + 1).trim();
  return { partial, dataExpr: dataExprRaw || '__data' };
}

const RESERVED_SCOPE_NAMES = new Set(['__out', '__data', '__esc', '__include', '__yield', '__toEntries']);

function createScopeProxy(data) {
  return new Proxy(data, {
    has(target, prop) {
      return RESERVED_SCOPE_NAMES.has(prop) ? false : true;
    },
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && prop in globalThis) return globalThis[prop];
      return undefined;
    },
  });
}

export function compileTemplate(source, options = {}) {
  const filename = options.filename || '<template>';
  const codeParts = ['let __out = "";', 'with (__data) {'];
  const stack = [];

  const pushText = (text) => {
    if (text) codeParts.push(`__out += ${JSON.stringify(text)};`);
  };
  const requireTop = (expected, tag) => {
    if (stack[stack.length - 1] !== expected) {
      throw new Error(`jiffyback view "${filename}": {{${tag}}} without a matching {{${expected === 'if' ? 'if' : 'each'}}}`);
    }
  };

  let i = 0;
  while (i < source.length) {
    const start = source.indexOf('{{', i);
    if (start === -1) {
      pushText(source.slice(i));
      break;
    }
    pushText(source.slice(i, start));

    const isRaw = source[start + 2] === '{';
    const closeSeq = isRaw ? '}}}' : '}}';
    const contentStart = start + (isRaw ? 3 : 2);
    const end = source.indexOf(closeSeq, contentStart);
    if (end === -1) {
      throw new Error(`jiffyback view "${filename}": unclosed "${isRaw ? '{{{' : '{{'}" (no matching "${closeSeq}")`);
    }
    const inner = source.slice(contentStart, end).trim();
    i = end + closeSeq.length;

    if (isRaw) {
      codeParts.push(`{ const __v = (${inner}); __out += (__v === null || __v === undefined) ? '' : String(__v); }`);
      continue;
    }
    if (inner === '' || inner[0] === '!') continue;

    if (inner === 'yield') {
      codeParts.push(`__out += (__yield === undefined || __yield === null) ? '' : __yield;`);
    } else if (inner.startsWith('if ')) {
      codeParts.push(`if (${inner.slice(3).trim()}) {`);
      stack.push('if');
    } else if (inner.startsWith('elseif ')) {
      requireTop('if', 'elseif');
      codeParts.push(`} else if (${inner.slice(7).trim()}) {`);
    } else if (inner === 'else') {
      requireTop('if', 'else');
      codeParts.push('} else {');
    } else if (inner === '/if') {
      requireTop('if', '/if');
      stack.pop();
      codeParts.push('}');
    } else if (inner.startsWith('each ')) {
      const { itemName, indexName, iterableExpr } = parseEach(inner, filename);
      codeParts.push(`for (const [${indexName || '__i'}, ${itemName}] of __toEntries(${iterableExpr})) {`);
      stack.push('each');
    } else if (inner === '/each') {
      requireTop('each', '/each');
      stack.pop();
      codeParts.push('}');
    } else if (inner.startsWith('include ')) {
      const { partial, dataExpr } = parseInclude(inner, filename);
      codeParts.push(`__out += await __include(${JSON.stringify(partial)}, (${dataExpr}));`);
    } else {
      codeParts.push(`__out += __esc(${inner});`);
    }
  }

  if (stack.length) {
    const kind = stack[stack.length - 1];
    throw new Error(`jiffyback view "${filename}": unclosed {{${kind === 'if' ? 'if' : 'each'}}} block (missing {{/${kind}}})`);
  }

  codeParts.push('}', 'return __out;');
  const body = codeParts.join('\n');

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction('__data', '__esc', '__include', '__yield', '__toEntries', body);
  } catch (err) {
    throw new Error(
      `jiffyback view "${filename}": template compiled to invalid JavaScript (${err.message}). ` +
        'This usually means a JS syntax error inside a {{ }} expression.'
    );
  }

  return async function render(data = {}, helpers = {}, yieldContent) {
    const esc = helpers.esc || escapeHtml;
    const include =
      helpers.include ||
      (() => {
        throw new Error(
          `jiffyback view "${filename}": {{include}} was used but no include handler was provided - ` +
            'use createViewEngine() instead of compileTemplate() directly to get {{include}}/{{yield}} support.'
        );
      });
    return fn(createScopeProxy(data), esc, include, yieldContent, toEntries);
  };
}

export function createViewEngine(options = {}) {
  if (!options.dir) throw new TypeError('createViewEngine: options.dir is required');
  const root = path.resolve(options.dir);
  const ext = String(options.ext || 'html').replace(/^\./, '');
  const useCache = options.cache !== false;
  const defaultLayout = options.layout;
  const compiledCache = new Map();

  function resolveView(name) {
    const rel = name.endsWith(`.${ext}`) ? name : `${name}.${ext}`;
    const abs = safeJoin(root, rel);
    if (!abs) throw new Error(`jiffyback view: invalid view name "${name}"`);
    return abs;
  }

  async function loadCompiled(absPath, displayName) {
    let stat;
    try {
      stat = await fs.promises.stat(absPath);
    } catch {
      throw new Error(`jiffyback view: view not found: "${displayName}" (looked for ${absPath})`);
    }
    if (!stat.isFile()) throw new Error(`jiffyback view: "${displayName}" is not a file`);

    if (useCache) {
      const cached = compiledCache.get(absPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.compiled;
    }
    const source = await fs.promises.readFile(absPath, 'utf8');
    const compiled = compileTemplate(source, { filename: displayName });
    if (useCache) compiledCache.set(absPath, { mtimeMs: stat.mtimeMs, compiled });
    return compiled;
  }

  async function renderView(name, data = {}, depth = 0) {
    if (depth > 50) {
      throw new Error(`jiffyback view: {{include}} nested too deep (>50) rendering "${name}" - likely a circular include`);
    }
    const absPath = resolveView(name);
    const compiled = await loadCompiled(absPath, name);
    const include = (partialName, partialData) => renderView(partialName, partialData, depth + 1);
    return compiled(data, { esc: escapeHtml, include });
  }

  async function render(name, data = {}, renderOptions = {}) {
    const body = await renderView(name, data);
    const layoutName = 'layout' in renderOptions ? renderOptions.layout : defaultLayout;
    if (!layoutName) return body;
    const layoutAbs = resolveView(layoutName);
    const compiled = await loadCompiled(layoutAbs, layoutName);
    const include = (partialName, partialData) => renderView(partialName, partialData, 1);
    return compiled(data, { esc: escapeHtml, include }, body);
  }

  return { render, renderView, resolveView };
}
