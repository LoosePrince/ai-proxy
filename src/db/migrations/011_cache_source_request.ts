/**
 * 011 — 缓存指向最初生成它的请求日志。
 *
 * response_cache 是缓存正文的唯一主存储；source_trace_id 只保存可选的
 * 来源日志引用。来源日志可能因保留策略被删除，因此不能使用强制外键。
 */
export const migration011CacheSourceRequest = {
  id: '011_cache_source_request',
  statements: [
    `alter table response_cache add column source_trace_id text`,
    `update response_cache
        set source_trace_id = (
          select r.trace_id
            from requests r
           where r.cache_hit = 0
             and r.client_request_body = response_cache.client_request_body
             and r.requested_model is response_cache.requested_model
             and r.stream = response_cache.stream
             and r.started_at <= response_cache.created_at
           order by r.started_at asc
           limit 1
        )
      where source_trace_id is null
        and client_request_body is not null`,
    `create index if not exists idx_response_cache_source_trace on response_cache (source_trace_id)`,
  ],
};