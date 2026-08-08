/**
 * 迁移执行器。
 *
 * 每个迁移是一组 SQL 语句，整组放进一次 transaction，并在同一事务里写入
 * `_migrations`，保证「执行成功」与「已记录」原子一致 —— 不会出现执行一半
 * 却记为完成的中间态。重复执行是幂等的。
 */

import { getDb, type LsqliteStatement } from './lsqlite';
import { migration001Init } from './migrations/001_init';

export interface Migration {
  id: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [migration001Init];

const CREATE_MIGRATIONS_TABLE = `
create table if not exists _migrations (
  id text primary key,
  applied_at text not null
)`;

async function getAppliedIds(): Promise<Set<string>> {
  const db = getDb();
  const rows = await db.select<{ id: string }>('select id from _migrations');
  return new Set(rows.map((row) => row.id));
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(): Promise<MigrateResult> {
  const db = getDb();
  await db.execute(CREATE_MIGRATIONS_TABLE);

  const applied = await getAppliedIds();
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      result.skipped.push(migration.id);
      continue;
    }

    const statements: LsqliteStatement[] = migration.statements.map((sql) => ({
      sql,
      params: [],
      mode: 'write' as const,
    }));

    statements.push({
      sql: 'insert into _migrations (id, applied_at) values (?, ?)',
      params: [migration.id, new Date().toISOString()],
      mode: 'write',
    });

    await db.transaction(statements);
    result.applied.push(migration.id);
    console.log(`[Migrate] applied ${migration.id}`);
  }

  return result;
}