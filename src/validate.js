export class ValidationError extends Error {
  constructor(issues) {
    super(`Validation failed: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function joinPath(base, segment) {
  if (base === '') return segment;
  return typeof segment === 'string' && segment.startsWith('[') ? base + segment : `${base}.${segment}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

class Schema {
  constructor(def) {
    this._def = def;
  }

  _clone(patch) {
    return new this.constructor({ ...this._def, ...patch });
  }

  optional() {
    return this._clone({ optional: true });
  }

  nullable() {
    return this._clone({ nullable: true });
  }

  default(value) {
    return this._clone({ default: value });
  }

  refine(fn, message = 'Failed custom validation') {
    const prevRefinements = this._def.refinements || [];
    return this._clone({ refinements: [...prevRefinements, { fn, message }] });
  }

  _parse(value, path, issues) {
    if (value === undefined && 'default' in this._def) {
      value = typeof this._def.default === 'function' ? this._def.default() : this._def.default;
    }

    if (value === undefined) {
      if (!this._def.optional) issues.push({ path, message: 'Required' });
      return undefined;
    }

    if (value === null) {
      if (!this._def.nullable) issues.push({ path, message: 'Must not be null' });
      return null;
    }

    const before = issues.length;
    const parsed = this._parseType(value, path, issues);
    if (issues.length !== before) return undefined;

    for (const { fn, message } of this._def.refinements || []) {
      let ok;
      try {
        ok = fn(parsed);
      } catch {
        ok = false;
      }
      if (!ok) issues.push({ path, message });
    }

    return parsed;
  }

  safeParse(value) {
    const issues = [];
    const data = this._parse(value, '', issues);
    return issues.length ? { success: false, errors: issues } : { success: true, data };
  }

  parse(value) {
    const result = this.safeParse(value);
    if (!result.success) throw new ValidationError(result.errors);
    return result.data;
  }
}

class StringSchema extends Schema {
  min(n) {
    return this._clone({ min: n });
  }
  max(n) {
    return this._clone({ max: n });
  }
  length(n) {
    return this._clone({ length: n });
  }
  pattern(re, message = 'Invalid format') {
    return this._clone({ pattern: re, patternMessage: message });
  }
  email() {
    return this._clone({ pattern: EMAIL_RE, patternMessage: 'Invalid email address' });
  }
  url() {
    return this._clone({ pattern: URL_RE, patternMessage: 'Invalid URL' });
  }
  trim() {
    return this._clone({ trim: true });
  }
  nonEmpty() {
    return this._clone({ min: 1, minMessage: 'Must not be empty' });
  }

  _parseType(value, path, issues) {
    if (typeof value !== 'string') {
      issues.push({ path, message: 'Must be a string' });
      return undefined;
    }
    let v = this._def.trim ? value.trim() : value;
    const d = this._def;
    if (d.length !== undefined && v.length !== d.length) {
      issues.push({ path, message: `Must be exactly ${d.length} characters` });
      return undefined;
    }
    if (d.min !== undefined && v.length < d.min) {
      issues.push({ path, message: d.minMessage || `Must be at least ${d.min} characters` });
      return undefined;
    }
    if (d.max !== undefined && v.length > d.max) {
      issues.push({ path, message: `Must be at most ${d.max} characters` });
      return undefined;
    }
    if (d.pattern && !d.pattern.test(v)) {
      issues.push({ path, message: d.patternMessage });
      return undefined;
    }
    return v;
  }
}

class NumberSchema extends Schema {
  min(n) {
    return this._clone({ min: n });
  }
  max(n) {
    return this._clone({ max: n });
  }
  integer() {
    return this._clone({ integer: true });
  }
  positive() {
    return this._clone({ min: 0, minExclusive: true, minMessage: 'Must be positive' });
  }
  coerce() {
    return this._clone({ coerce: true });
  }

  _parseType(value, path, issues) {
    let v = value;
    if (this._def.coerce && typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (!Number.isNaN(n)) v = n;
    }
    if (typeof v !== 'number' || Number.isNaN(v)) {
      issues.push({ path, message: 'Must be a number' });
      return undefined;
    }
    const d = this._def;
    if (d.integer && !Number.isInteger(v)) {
      issues.push({ path, message: 'Must be an integer' });
      return undefined;
    }
    if (d.min !== undefined) {
      const fails = d.minExclusive ? v <= d.min : v < d.min;
      if (fails) {
        issues.push({ path, message: d.minMessage || `Must be at least ${d.min}` });
        return undefined;
      }
    }
    if (d.max !== undefined && v > d.max) {
      issues.push({ path, message: `Must be at most ${d.max}` });
      return undefined;
    }
    return v;
  }
}

class BooleanSchema extends Schema {
  coerce() {
    return this._clone({ coerce: true });
  }

  _parseType(value, path, issues) {
    let v = value;
    if (this._def.coerce && typeof v === 'string') {
      if (v === 'true' || v === '1') v = true;
      else if (v === 'false' || v === '0') v = false;
    }
    if (typeof v !== 'boolean') {
      issues.push({ path, message: 'Must be a boolean' });
      return undefined;
    }
    return v;
  }
}

class ObjectSchema extends Schema {
  strict() {
    return this._clone({ strict: true });
  }

  _parseType(value, path, issues) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ path, message: 'Must be an object' });
      return undefined;
    }
    const shape = this._def.shape;
    const out = {};
    for (const key of Object.keys(shape)) {
      const childIssues = [];
      const parsed = shape[key]._parse(value[key], joinPath(path, key), childIssues);
      issues.push(...childIssues);
      if (childIssues.length === 0 && parsed !== undefined) out[key] = parsed;
    }
    if (this._def.strict) {
      for (const key of Object.keys(value)) {
        if (!(key in shape)) issues.push({ path: joinPath(path, key), message: 'Unrecognized key' });
      }
    }
    return out;
  }
}

class ArraySchema extends Schema {
  min(n) {
    return this._clone({ min: n });
  }
  max(n) {
    return this._clone({ max: n });
  }

  _parseType(value, path, issues) {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'Must be an array' });
      return undefined;
    }
    const d = this._def;
    if (d.min !== undefined && value.length < d.min) {
      issues.push({ path, message: `Must have at least ${d.min} item(s)` });
      return undefined;
    }
    if (d.max !== undefined && value.length > d.max) {
      issues.push({ path, message: `Must have at most ${d.max} item(s)` });
      return undefined;
    }
    const out = [];
    value.forEach((item, i) => {
      const childIssues = [];
      const parsed = d.item._parse(item, joinPath(path, `[${i}]`), childIssues);
      issues.push(...childIssues);
      if (childIssues.length === 0) out.push(parsed);
    });
    return out;
  }
}

class AnySchema extends Schema {
  _parseType(value) {
    return value;
  }
}

export const v = {
  string: () => new StringSchema({}),
  number: () => new NumberSchema({}),
  boolean: () => new BooleanSchema({}),
  object: (shape) => new ObjectSchema({ shape }),
  array: (item) => new ArraySchema({ item }),
  any: () => new AnySchema({}),
};

export function validate(schema, options = {}) {
  const source = options.source || 'body';
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      res.status(400).json({ error: 'Validation failed', errors: result.errors });
      return;
    }
    req[source] = result.data;
    next();
  };
}
