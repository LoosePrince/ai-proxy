/** IP 黑名单仓储。黑名单读取进入配置快照，请求热路径不访问数据库。 */

import { getDb } from '../lsqlite';

export interface IpBlacklistRecord {
  ip: string;
  note: string | null;
  createdAt: string;
}

interface IpBlacklistRow {
  ip: string;
  note: string | null;
  created_at: string;
}

function toRecord(row: IpBlacklistRow): IpBlacklistRecord {
  return { ip: row.ip, note: row.note, createdAt: row.created_at };
}

export async function listIpBlacklist(): Promise<IpBlacklistRecord[]> {
  const rows = await getDb().select<IpBlacklistRow>(
    'select ip, note, created_at from ip_blacklist order by created_at desc, ip asc',
  );
  return rows.map(toRecord);
}

export async function loadBlacklistedIps(): Promise<Set<string>> {
  const rows = await getDb().select<{ ip: string }>('select ip from ip_blacklist');
  return new Set(rows.map((row) => row.ip));
}

export async function addIpBlacklist(ip: string, note: string | null): Promise<IpBlacklistRecord> {
  const createdAt = new Date().toISOString();
  await getDb().execute(
    'insert into ip_blacklist (ip, note, created_at) values (?, ?, ?) on conflict(ip) do update set note = excluded.note',
    [ip, note, createdAt],
  );
  const row = await getDb().selectOne<IpBlacklistRow>(
    'select ip, note, created_at from ip_blacklist where ip = ?',
    [ip],
  );
  if (!row) throw new Error('IP 黑名单写入后未找到记录');
  return toRecord(row);
}

export async function removeIpBlacklist(ip: string): Promise<void> {
  await getDb().execute('delete from ip_blacklist where ip = ?', [ip]);
}