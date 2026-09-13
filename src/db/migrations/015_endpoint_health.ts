/**
 * 015 —— 端点健康日聚合（维度：provider × model × day）。
 *
 * 后台「状态监控」页要回答两个问题：
 *   1. 每个渠道（provider）最近还通不通、多慢？
 *   2. 每个模型最近被路由到哪里、可用率和延迟如何？超时/失败集中在哪个模型？
 *
 * 这些数字不能用「扫描 requests / request_attempts 现算」的方式得到：
 *   - 明细表会被 logRetentionDays 清理，30 天窗口随时可能断档；
 *   - Lsqlite 是远程 HTTPS SQLite，每次查询都是一次网络往返，
 *     按需扫描 30 天尝试记录会随着流量线性变慢。
 * 因此沿用既有做法（provider_usage_daily / model_usage_daily）：热路径写聚合，
 * 面板只读聚合。粒度选「provider × model × day」，一张表同时支撑渠道视图与模型视图。
 *
 * 口径（与 requests.ts 的写入侧保持一致）：
 *   - attempts 只统计真正打到上游的尝试；
 *   - success / failed / claimed 按 attempt.status 三分，
 *     claimed-by-other（并行竞速落败）既不算成功也不算失败，不进可用率分母；
 *   - duration_* 与 ttfb_min_ms 只取成功尝试（失败的耗时没有可比性）；
 *   - ttfb_min_ms 是该日成功请求首字节的最小值，作为「端点连通延迟」的近似。
 *
 * 建表后同事务内回填已有明细，让新页上线即有数据（受日志保留期约束）。
 */

export const migration015EndpointHealth = {
  id: '015_endpoint_health',
  statements: [
    `create table if not exists endpoint_health_daily (
      provider_id integer not null default 0,
      provider_name text not null default '',
      model text not null,
      day text not null,
      attempts integer not null default 0,
      success integer not null default 0,
      failed integer not null default 0,
      claimed integer not null default 0,
      duration_sum_ms integer not null default 0,
      duration_count integer not null default 0,
      ttfb_min_ms integer,
      last_seen_at text,
      primary key (provider_id, model, day)
    )`,

    `create index if not exists idx_endpoint_health_day on endpoint_health_daily (day desc)`,
    `create index if not exists idx_endpoint_health_model on endpoint_health_daily (model, day desc)`,

    /*
     * 回填：`(unspecified)` 必须与 requests.ts 的 UNKNOWN_MODEL 保持一致 ——
     * 迁移刻意不 import 仓储模块，让迁移保持自包含的纯 SQL。
     * provider_id 为 null 的尝试（理论上不出现）归到 0，避免整组被丢弃。
     */
    `insert into endpoint_health_daily (
        provider_id, provider_name, model, day,
        attempts, success, failed, claimed,
        duration_sum_ms, duration_count, ttfb_min_ms, last_seen_at
      )
      select
        coalesce(a.provider_id, 0)                                          as provider_id,
        coalesce(a.provider_name, '')                                       as provider_name,
        coalesce(a.actual_model, a.attempted_model, '(unspecified)')        as model,
        substr(a.started_at, 1, 10)                                         as day,
        count(*)                                                            as attempts,
        sum(case when a.status = 'success' then 1 else 0 end)               as success,
        sum(case when a.status = 'failed' then 1 else 0 end)                as failed,
        sum(case when a.status = 'claimed-by-other' then 1 else 0 end)      as claimed,
        sum(case when a.status = 'success' then coalesce(a.duration_ms, 0) else 0 end) as duration_sum_ms,
        sum(case when a.status = 'success' and a.duration_ms is not null then 1 else 0 end) as duration_count,
        min(case when a.status = 'success' then r.ttfb_ms else null end)    as ttfb_min_ms,
        max(a.started_at)                                                   as last_seen_at
      from request_attempts a
      join requests r on r.id = a.request_id
      group by
        coalesce(a.provider_id, 0),
        coalesce(a.provider_name, ''),
        coalesce(a.actual_model, a.attempted_model, '(unspecified)'),
        substr(a.started_at, 1, 10)
      on conflict (provider_id, model, day) do nothing`,
  ],
};
