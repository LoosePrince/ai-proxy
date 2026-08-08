/**
 * 轻量 SQL 构造 DSL。
 *
 * 设计约束：值一律走 `?` 参数绑定，标识符（表名/列名）只允许安全字符，
 * 因为 Lsqlite 是远程 SQL 端点，任何字符串拼接都是注入面。
 */

import type { LsqliteStatement } from './lsqlite';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

export type SqlValue = string | number | boolean | null;

/** JS 值 → SQLite 可存储值。布尔存 0/1，undefined 视作 null。 */
function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export interface WhereClause {
  sql: string;
  params: SqlValue[];
}

/** 等值条件组合，`undefined` 的字段被忽略，便于可选筛选 */
export function whereEq(conditions: Record<string, unknown>): WhereClause {
  const parts: string[] = [];
  const params: SqlValue[] = [];

  for (const [column, value] of Object.entries(conditions)) {
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`${ident(column)} is null`);
      continue;
    }
    parts.push(`${ident(column)} = ?`);
    params.push(toSqlValue(value));
  }

  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', params };
}

export function and(...clauses: Array<WhereClause | null | undefined>): WhereClause {
  const parts: string[] = [];
  const params: SqlValue[] = [];

  for (const clause of clauses) {
    if (!clause || !clause.sql) continue;
    parts.push(clause.sql.replace(/^where\s+/i, ''));
    params.push(...clause.params);
  }

  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', params };
}

export function raw(sql: string, params: SqlValue[] = []): WhereClause {
  return { sql, params };
}

export function insert(table: string, values: Record<string, unknown>): LsqliteStatement {
  const columns = Object.keys(values).filter((key) => values[key] !== undefined);
  if (columns.length === 0) throw new Error(`insert into ${table} requires at least one column`);

  return {
    sql: `insert into ${ident(table)} (${columns.map(ident).join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    params: columns.map((column) => toSqlValue(values[column])),
    mode: 'write',
  };
}

export interface UpsertOptions {
  /** 冲突键 */
  conflict: string[];
  /** 直接覆盖的列 */
  set?: string[];
  /** 累加的列：`col = col + excluded.col`，日聚合的原子累加靠这个 */
  increment?: string[];
}

export function upsert(
  table: string,
  values: Record<string, unknown>,
  options: UpsertOptions,
): LsqliteStatement {
  const base = insert(table, values);
  const assignments: string[] = [];

  for (const column of options.increment ?? []) {
    assignments.push(`${ident(column)} = ${ident(table)}.${ident(column)} + excluded.${ident(column)}`);
  }
  for (const column of options.set ?? []) {
    assignments.push(`${ident(column)} = excluded.${ident(column)}`);
  }

  const action = assignments.length ? `do update set ${assignments.join(', ')}` : 'do nothing';

  return {
    sql: `${base.sql} on conflict (${options.conflict.map(ident).join(', ')}) ${action}`,
    params: base.params,
    mode: 'write',
  };
}

export function update(
  table: string,
  values: Record<string, unknown>,
  where: WhereClause,
): LsqliteStatement {
  const columns = Object.keys(values).filter((key) => values[key] !== undefined);
  if (columns.length === 0) throw new Error(`update ${table} requires at least one column`);
  if (!where.sql) throw new Error(`update ${table} requires a where clause`);

  return {
    sql: `update ${ident(table)} set ${columns.map((column) => `${ident(column)} = ?`).join(', ')} ${where.sql}`,
    params: [...columns.map((column) => toSqlValue(values[column])), ...where.params],
    mode: 'write',
  };
}

export function remove(table: string, where: WhereClause): LsqliteStatement {
  if (!where.sql) throw new Error(`delete from ${table} requires a where clause`);
  return {
    sql: `delete from ${ident(table)} ${where.sql}`,
    params: where.params,
    mode: 'write',
  };
}

export interface SelectOptions {
  columns?: string;
  where?: WhereClause;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export function select(table: string, options: SelectOptions = {}): LsqliteStatement {
  const where = options.where ?? { sql: '', params: [] };
  const params: SqlValue[] = [...where.params];
  let sql = `select ${options.columns ?? '*'} from ${ident(table)}`;

  if (where.sql) sql += ` ${where.sql}`;
  if (options.orderBy) sql += ` order by ${options.orderBy}`;
  if (options.limit !== undefined) {
    sql += ' limit ?';
    params.push(options.limit);
  }
  if (options.offset !== undefined) {
    sql += ' offset ?';
    params.push(options.offset);
  }

  return { sql, params, mode: 'read' };
}

export { ident, toSqlValue };