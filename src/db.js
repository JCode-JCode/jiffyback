import { createRequire } from 'node:module';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(name) {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new TypeError(
      `jiffyback db: "${name}" is not a valid table/column identifier (letters, digits, underscore only, ` +
        "not starting with a digit) - if this came from user input, that's exactly what this check exists to catch."
    );
  }
  return `"${name}"`;
}

function toNonNegativeInt(n, label) {
  const isNumericString = typeof n === 'string' && n.trim() !== '';
  if (typeof n !== 'number' && !isNumericString) {
    throw new TypeError(`jiffyback db: ${label}() expects a non-negative integer, got ${JSON.stringify(n)}`);
  }
  const num = Number(n);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw new TypeError(`jiffyback db: ${label}() expects a non-negative integer, got ${JSON.stringify(n)}`);
  }
  return num;
}

const OPERATORS = new Set(['=', '!=', '<>', '<', '<=', '>', '>=', 'like', 'not like']);

class QueryBuilder {
  constructor(adapter, table) {
    this._adapter = adapter;
    this._table = quoteIdentifier(table);
    this._wheres = [];
    this._selectCols = '*';
    this._orderBy = null;
    this._limit = null;
    this._offset = null;
  }

  select(...columns) {
    this._selectCols = columns.flat().map(quoteIdentifier).join(', ');
    return this;
  }

  where(column, operatorOrValue, maybeValue) {
    if (column && typeof column === 'object') {
      for (const [col, val] of Object.entries(column)) this._pushWhere('AND', col, '=', val);
      return this;
    }
    const hasExplicitOperator = maybeValue !== undefined;
    const operator = hasExplicitOperator ? String(operatorOrValue).toLowerCase() : '=';
    const value = hasExplicitOperator ? maybeValue : operatorOrValue;
    this._pushWhere('AND', column, operator, value);
    return this;
  }

  orWhere(column, operatorOrValue, maybeValue) {
    const hasExplicitOperator = maybeValue !== undefined;
    const operator = hasExplicitOperator ? String(operatorOrValue).toLowerCase() : '=';
    const value = hasExplicitOperator ? maybeValue : operatorOrValue;
    this._pushWhere('OR', column, operator, value);
    return this;
  }

  whereIn(column, values) {
    if (!Array.isArray(values) || values.length === 0) {
      this._wheres.push({ connector: 'AND', sql: '1 = 0', params: [] });
      return this;
    }
    const placeholders = values.map(() => '?').join(', ');
    this._wheres.push({ connector: 'AND', sql: `${quoteIdentifier(column)} IN (${placeholders})`, params: [...values] });
    return this;
  }

  whereNull(column) {
    this._wheres.push({ connector: 'AND', sql: `${quoteIdentifier(column)} IS NULL`, params: [] });
    return this;
  }

  whereNotNull(column) {
    this._wheres.push({ connector: 'AND', sql: `${quoteIdentifier(column)} IS NOT NULL`, params: [] });
    return this;
  }

  _pushWhere(connector, column, operator, value) {
    if (!OPERATORS.has(operator)) {
      throw new TypeError(`jiffyback db: unsupported where() operator "${operator}"`);
    }
    this._wheres.push({ connector, sql: `${quoteIdentifier(column)} ${operator} ?`, params: [value] });
  }

  orderBy(column, direction = 'asc') {
    const dir = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    this._orderBy = `${quoteIdentifier(column)} ${dir}`;
    return this;
  }

  limit(n) {
    this._limit = toNonNegativeInt(n, 'limit');
    return this;
  }

  offset(n) {
    this._offset = toNonNegativeInt(n, 'offset');
    return this;
  }

  _buildWhereClause() {
    if (this._wheres.length === 0) return { sql: '', params: [] };
    let sql = ` WHERE ${this._wheres[0].sql}`;
    const params = [...this._wheres[0].params];
    for (let i = 1; i < this._wheres.length; i++) {
      sql += ` ${this._wheres[i].connector} ${this._wheres[i].sql}`;
      params.push(...this._wheres[i].params);
    }
    return { sql, params };
  }

  async get() {
    const { sql: whereSql, params } = this._buildWhereClause();
    let sql = `SELECT ${this._selectCols} FROM ${this._table}${whereSql}`;
    if (this._orderBy) sql += ` ORDER BY ${this._orderBy}`;
    if (this._limit !== null) sql += ` LIMIT ${this._limit}`;
    if (this._offset !== null) sql += ` OFFSET ${this._offset}`;
    const result = await this._adapter.query(sql, params);
    return result.rows;
  }

  async first() {
    const rows = await this.limit(1).get();
    return rows[0] ?? null;
  }

  async count() {
    const { sql: whereSql, params } = this._buildWhereClause();
    const sql = `SELECT COUNT(*) AS count FROM ${this._table}${whereSql}`;
    const result = await this._adapter.query(sql, params);
    const row = result.rows[0];
    return row ? Number(row.count) : 0;
  }

  async insert(values) {
    const columns = Object.keys(values);
    if (columns.length === 0) throw new TypeError('jiffyback db: insert() requires at least one column');
    const columnSql = columns.map(quoteIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${this._table} (${columnSql}) VALUES (${placeholders})`;
    const result = await this._adapter.query(sql, columns.map((c) => values[c]));
    return result.insertId;
  }

  async update(values) {
    const columns = Object.keys(values);
    if (columns.length === 0) throw new TypeError('jiffyback db: update() requires at least one column');
    const setSql = columns.map((c) => `${quoteIdentifier(c)} = ?`).join(', ');
    const { sql: whereSql, params: whereParams } = this._buildWhereClause();
    if (!whereSql) {
      throw new Error(
        'jiffyback db: update() with no where() clause would update every row in the table - ' +
          'if that is really what you want, add .where(() => true)-style guard is not supported; ' +
          'use a raw db.query() instead to make the intent explicit.'
      );
    }
    const sql = `UPDATE ${this._table} SET ${setSql}${whereSql}`;
    const result = await this._adapter.query(sql, [...columns.map((c) => values[c]), ...whereParams]);
    return result.changes;
  }

  async delete() {
    const { sql: whereSql, params } = this._buildWhereClause();
    if (!whereSql) {
      throw new Error(
        'jiffyback db: delete() with no where() clause would delete every row in the table - ' +
          'use a raw db.query() instead to make the intent explicit.'
      );
    }
    const sql = `DELETE FROM ${this._table}${whereSql}`;
    const result = await this._adapter.query(sql, params);
    return result.changes;
  }
}

export function createDatabase(adapter) {
  return {
    table(name) {
      return new QueryBuilder(adapter, name);
    },
    query(sql, params = []) {
      return adapter.query(sql, params);
    },
    async transaction(fn) {
      if (typeof adapter.transaction !== 'function') {
        throw new Error('jiffyback db: this adapter does not support transaction() - see createAdapter() in db.js for the shape a transaction-capable adapter needs.');
      }
      return adapter.transaction(async (txAdapter) => fn(createDatabase(txAdapter)));
    },
    close() {
      return adapter.close ? adapter.close() : undefined;
    },
  };
}

export function sqliteAdapter(filename) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch (err) {
    throw new Error(
      "jiffyback db: sqliteAdapter() requires Node's node:sqlite module (Node >=22.5, currently experimental). " +
        `Original error: ${err.message}`
    );
  }

  const db = new DatabaseSync(filename);

  function run(sql, params) {
    const stmt = db.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
      return { rows: stmt.all(...params) };
    }
    const info = stmt.run(...params);
    return { rows: [], insertId: info.lastInsertRowid, changes: info.changes };
  }

  return {
    async query(sql, params = []) {
      return run(sql, params);
    },
    async transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn({
          async query(sql, params = []) {
            return run(sql, params);
          },
        });
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async close() {
      db.close();
    },
  };
}

export function createAdapter() {
  throw new Error(
    'jiffyback db: createAdapter() is documentation, not a runnable factory - see the JSDoc example above it ' +
      'for the adapter shape to implement for your own database driver.'
  );
}
