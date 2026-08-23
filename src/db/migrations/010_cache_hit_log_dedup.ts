/**
 * 010 — 缓存命中日志去重。
 *
 * 缓存命中仍保留独立的请求日志，但正文改为引用 response_cache，避免每次命中
 * 都把同一份响应再次写入 requests。先把历史命中日志绑定到对应缓存，再清空
 * 重复正文；详情查询时按 cache_key 取回缓存正文。
 */
export const migration010CacheHitLogDedup = {
  id: '010_cache_hit_log_dedup',
  statements: [
    `alter table response_cache add column client_request_body text`,
    `alter table requests add column cache_key text`,
    `create index if not exists idx_requests_cache_key on requests (cache_key)`,
    `update requests
        set cache_key = (
          select c.cache_key
            from response_cache c
           where c.created_at = json_extract(requests.upstream_request_body, '$.cacheCreatedAt')
           limit 1
        )
      where cache_hit = 1
        and cache_key is null
        and upstream_request_body is not null
        and json_valid(upstream_request_body)`,
    `update response_cache
        set client_request_body = (
          select r.client_request_body
            from requests r
           where r.cache_hit = 1
             and r.client_request_body is not null
             and r.upstream_request_body is not null
             and json_valid(r.upstream_request_body)
             and json_extract(r.upstream_request_body, '$.cacheCreatedAt') = response_cache.created_at
           order by r.started_at asc
           limit 1
        )
      where client_request_body is null`,
    `update requests
        set upstream_request_body = null,
            ai_response_body = null
      where cache_hit = 1
        and cache_key is not null`,
    `update requests
        set client_request_body = null
      where cache_hit = 1
        and cache_key is not null
        and exists (
          select 1 from response_cache c
           where c.cache_key = requests.cache_key
             and c.client_request_body is not null
        )`,
  ],
};