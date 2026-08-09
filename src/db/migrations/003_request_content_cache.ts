/**
 * 请求正文记录与第一版持久化响应缓存。
 *
 * 迁移一旦发布必须保持不可变。缓存的线格式升级由后续迁移负责，避免已经
 * 记录为执行完成的实例与全新实例得到不同结构。
 */
export const migration003RequestContentCache = {
  id: '003_request_content_cache',
  statements: [
    `alter table requests add column cache_hit integer not null default 0`,
    `alter table requests add column client_request_body text`,
    `alter table requests add column upstream_request_body text`,
    `alter table requests add column ai_response_body text`,
    `create table if not exists response_cache (
      cache_key text primary key,
      protocol text not null,
      stream integer not null,
      response_content text not null,
      actual_model text not null,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      created_at text not null,
      last_hit_at text,
      hit_count integer not null default 0
    )`,
    `create index if not exists idx_response_cache_created on response_cache (created_at desc)`,
  ],
};