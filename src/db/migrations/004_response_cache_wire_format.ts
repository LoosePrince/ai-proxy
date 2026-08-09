/**
 * 004 — 缓存线格式升级。
 *
 * 第一版只保存协议归一化内容，不能无损重放 Chat / Responses 的流式与非流式
 * HTTP 响应。缓存属于可重新生成的数据，因此这里显式失效旧缓存并建立可直接
 * 重放响应体的新结构；请求日志和用量数据不受影响。
 */
export const migration004ResponseCacheWireFormat = {
  id: '004_response_cache_wire_format',
  statements: [
    `drop table if exists response_cache`,
    `create table response_cache (
      cache_key text primary key,
      protocol text not null,
      stream integer not null,
      requested_model text,
      content_type text not null,
      response_body text not null,
      actual_model text,
      final_provider_id integer,
      final_provider_name text,
      final_role text,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0,
      created_at text not null,
      last_hit_at text,
      hit_count integer not null default 0
    )`,
    `create index idx_response_cache_created on response_cache (created_at desc)`,
  ],
};