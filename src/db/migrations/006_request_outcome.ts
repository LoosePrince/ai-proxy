/**
 * 006 —— 请求结局分类。
 *
 * 原先聚合表只有 success / failed 两列，是把「结局」压成了一个布尔。
 * 这导致两类语义在写入聚合的那一刻就被永久丢失：
 *   - 缓存命中被记为成功，同时虚增了那个 provider 的请求数与成功数，
 *     可它本次根本没被调用
 *   - 客户端主动断开被记为失败，把用户行为算成上游故障
 *
 * 这里给明细表加 outcome 列，给三张聚合表加分类计数列。
 * success / failed 两列保留并继续维护，含义收窄为：
 *   success = upstream_ok + cache_hit
 *   failed  = upstream_error + rejected     （不再包含 client_abort）
 *
 * 历史数据的回填只能做到当前信息量允许的程度：
 *   requests.cache_hit = 1              -> cache_hit
 *   requests.error_code = CLIENT_DISCONNECTED 或 http_status = 499 -> client_abort
 *   http_status = 429                   -> rejected
 *   其余按原 success 布尔归入 upstream_ok / upstream_error
 * 聚合表的历史行无法逐条还原（明细可能已被保留策略删除），因此只把
 * 现存明细能证明的部分迁出来，其余保持在原 success/failed 里不动 ——
 * 宁可让历史区间的分类计数偏保守，也不凭空构造数字。
 */

export const migration006RequestOutcome = {
  id: '006_request_outcome',
  statements: [
    `alter table requests add column outcome text`,

    // 明细回填：cache_hit 列与 error_code 是唯一可信的历史证据来源
    `update requests set outcome = 'cache_hit' where outcome is null and cache_hit = 1`,
    `update requests set outcome = 'client_abort'
       where outcome is null and (error_code = 'CLIENT_DISCONNECTED' or http_status = 499)`,
    `update requests set outcome = 'rejected'
       where outcome is null and (error_code = 'rate_limit_exceeded' or http_status = 429)`,
    `update requests set outcome = 'upstream_ok' where outcome is null and success = 1`,
    `update requests set outcome = 'upstream_error' where outcome is null`,
    `create index if not exists idx_requests_outcome on requests (outcome, started_at desc)`,

    // ---------- 聚合表分类计数列 ----------
    `alter table global_usage add column cache_hits integer not null default 0`,
    `alter table global_usage add column client_aborts integer not null default 0`,
    `alter table global_usage add column rejected integer not null default 0`,

    `alter table global_usage_daily add column cache_hits integer not null default 0`,
    `alter table global_usage_daily add column client_aborts integer not null default 0`,
    `alter table global_usage_daily add column rejected integer not null default 0`,

    `alter table provider_usage_daily add column cache_hits integer not null default 0`,
    `alter table provider_usage_daily add column client_aborts integer not null default 0`,
    `alter table provider_usage_daily add column rejected integer not null default 0`,

    /*
     * 把现存明细能证明的分类迁进日聚合。
     * client_abort 历史上被计入 failed，这里同时把它从 failed 中扣掉，
     * 否则新口径下 failed 会重复计算已经独立成列的取消量。
     */
    `update global_usage_daily set
       cache_hits = coalesce((
         select count(*) from requests r
         where substr(r.started_at, 1, 10) = global_usage_daily.day and r.outcome = 'cache_hit'
       ), 0),
       client_aborts = coalesce((
         select count(*) from requests r
         where substr(r.started_at, 1, 10) = global_usage_daily.day and r.outcome = 'client_abort'
       ), 0),
       rejected = coalesce((
         select count(*) from requests r
         where substr(r.started_at, 1, 10) = global_usage_daily.day and r.outcome = 'rejected'
       ), 0)`,

    `update global_usage_daily set failed = max(failed - client_aborts, 0) where client_aborts > 0`,

    `update provider_usage_daily set
       cache_hits = coalesce((
         select count(*) from requests r
         where substr(r.started_at, 1, 10) = provider_usage_daily.day
           and r.final_provider_id = provider_usage_daily.provider_id
           and r.outcome = 'cache_hit'
       ), 0),
       client_aborts = coalesce((
         select count(*) from requests r
         where substr(r.started_at, 1, 10) = provider_usage_daily.day
           and r.final_provider_id = provider_usage_daily.provider_id
           and r.outcome = 'client_abort'
       ), 0)`,

    /*
     * Provider 历史行的 requests / success / failed 也要同步纠正：
     * 缓存命中和客户端取消在旧版本都曾归属到缓存源 Provider，
     * 但它们本次没有构成可归责的上游调用，必须从 Provider 分母中移除。
     */
    `update provider_usage_daily set
       requests = max(requests - cache_hits - client_aborts, 0),
       success = max(success - cache_hits, 0),
       failed = max(failed - client_aborts, 0)
     where cache_hits > 0 or client_aborts > 0`,

    // 全站单行汇总由日聚合求和得到，保证两者口径一致
    `update global_usage set
       cache_hits = coalesce((select sum(cache_hits) from global_usage_daily), 0),
       client_aborts = coalesce((select sum(client_aborts) from global_usage_daily), 0),
       rejected = coalesce((select sum(rejected) from global_usage_daily), 0)
     where id = 1`,

    `update global_usage set failed = max(failed - client_aborts, 0) where id = 1 and client_aborts > 0`,
  ],
};