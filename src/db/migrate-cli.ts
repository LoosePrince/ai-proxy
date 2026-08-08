import 'dotenv/config';
import { runMigrations } from './migrate';
import { getDb } from './lsqlite';

async function main(): Promise<void> {
  const db = getDb();
  const healthy = await db.health();
  if (!healthy) {
    console.error('[Migrate] Lsqlite is unreachable, aborting');
    process.exit(1);
  }

  const result = await runMigrations();
  console.log(`[Migrate] applied=${result.applied.length} skipped=${result.skipped.length}`);
}

main().catch((error) => {
  console.error('[Migrate] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});