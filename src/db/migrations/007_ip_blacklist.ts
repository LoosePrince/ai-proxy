/** 007 —— IP 黑名单。 */
export const migration007IpBlacklist = {
  id: '007_ip_blacklist',
  statements: [
    `create table if not exists ip_blacklist (
      ip text primary key,
      note text,
      created_at text not null
    )`,
  ],
};