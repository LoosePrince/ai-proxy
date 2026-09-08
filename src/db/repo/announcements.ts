/**
 * 公告仓储。
 *
 * 管理端读全量（含停用），公开端只读启用行。
 * 正文由前端按 Markdown 渲染，这里不做内容转换，只保证字段完整。
 */

import { getDb } from '../lsqlite';
import type { AnnouncementInput } from '../../types/api';

export interface AnnouncementRecord {
  id: number;
  title: string;
  body: string;
  level: 'info' | 'warning' | 'success';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  level: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: AnnouncementRow): AnnouncementRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level === 'warning' || row.level === 'success' ? row.level : 'info',
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAnnouncements(): Promise<AnnouncementRecord[]> {
  const rows = await getDb().select<AnnouncementRow>(
    'select id, title, body, level, enabled, created_at, updated_at from announcements order by created_at desc, id desc',
  );
  return rows.map(toRecord);
}

export async function listEnabledAnnouncements(): Promise<AnnouncementRecord[]> {
  const rows = await getDb().select<AnnouncementRow>(
    'select id, title, body, level, enabled, created_at, updated_at from announcements where enabled = 1 order by created_at desc, id desc',
  );
  return rows.map(toRecord);
}

export async function createAnnouncement(input: AnnouncementInput): Promise<AnnouncementRecord> {
  // 远程 SQLite 不回传自增 id，用 (created_at, title) 定位刚插入的行
  const now = new Date().toISOString();
  await getDb().execute(
    'insert into announcements (title, body, level, enabled, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
    [input.title, input.body, input.level, input.enabled ? 1 : 0, now, now],
  );
  const row = await getDb().selectOne<AnnouncementRow>(
    'select id, title, body, level, enabled, created_at, updated_at from announcements where created_at = ? and title = ?',
    [now, input.title],
  );
  if (!row) throw new Error('公告写入后未找到记录');
  return toRecord(row);
}

export async function updateAnnouncement(
  id: number,
  patch: Partial<AnnouncementInput>,
): Promise<AnnouncementRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.body !== undefined) {
    sets.push('body = ?');
    params.push(patch.body);
  }
  if (patch.level !== undefined) {
    sets.push('level = ?');
    params.push(patch.level);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return findAnnouncementById(id);

  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  await getDb().execute(`update announcements set ${sets.join(', ')} where id = ?`, params);
  return findAnnouncementById(id);
}

export async function findAnnouncementById(id: number): Promise<AnnouncementRecord | null> {
  const row = await getDb().selectOne<AnnouncementRow>(
    'select id, title, body, level, enabled, created_at, updated_at from announcements where id = ?',
    [id],
  );
  return row ? toRecord(row) : null;
}

export async function deleteAnnouncement(id: number): Promise<boolean> {
  const result = await getDb().execute('delete from announcements where id = ?', [id]);
  return (result.rowCount ?? 0) > 0;
}
