/**
 * 012 — 公告表。
 *
 * 公告是站点运营信息，与 settings 的 key-value 形态不同：
 * 有多行、需要按时间排序与单独启停，因此是独立实体表。
 */
export const migration012Announcements = {
  id: '012_announcements',
  statements: [
    `create table if not exists announcements (
      id integer primary key autoincrement,
      title text not null,
      body text not null,
      level text not null default 'info',
      enabled integer not null default 1,
      created_at text not null,
      updated_at text not null
    )`,
    `create index if not exists idx_announcements_enabled on announcements (enabled, created_at desc)`,
  ],
};
