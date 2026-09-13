/**
 * 016 —— 渠道模型停用 + 端点健康的「声明模型」口径。
 *
 * 两件事：
 *   1. provider_models 增加 enabled 位。「渠道弹窗里关闭某个模型」= 视为
 *      无该模型：路由、模型候选与模型列表都不再包含它。用独立的位而不是
 *      删除行，是为了保留排序与「渠道声明了什么」的完整事实。
 *   2. endpoint_health_daily 的 model 列改为记录 **attempted_model**
 *      （站点通过渠道声明的模型发起请求时的模型名）。
 *
 *      口径要求：状态列表不使用「客户端自定义填写的模型」也不使用「上游响应
 *      的实际模型」，而是站点按声明模型发出上游请求时的模型名。attempted_model
 *      正是这个值（buildModelCandidates 的输出）；actual_model 才是上游响应
 *      里自报的名字，客户端自定义透传名两者都不采用。
 *
 *      同时把主键从 (provider_id, model, day) 改为 (provider_id, attempted_model, day)：
 *      同一渠道同一模型在「重命名后兼容旧历史」与「跨天聚合」之间只能取一个，
 *      这里选跨天聚合 —— 模型改名是低频事件，改名当天的少量旧名行通过
 *      provider_name 式的归并查询吸收，不单独建映射。
 *
 * 迁移同事务内从 request_attempts 按新口径重建全部历史。
 */

export const migration016ModelHealthRouting = {
  id: '016_model_health_routing',
  statements: [
    `alter table provider_models add column enabled integer not null default 1`,
    `create index if not exists idx_provider_models_enabled on provider_models (provider_id, enabled, sort_order)`,

    `drop index if exists idx_endpoint_health_day`,
    `drop index if exists idx_endpoint_health_model`,

    // 重建为新主键口径，并把历史明细按 attempted_model 重新聚合
    `create table endpoint_health_daily_new (
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

    `insert into endpoint_health_daily_new (
        provider_id, provider_name, model, day,
        attempts, success, failed, claimed,
        duration_sum_ms, duration_count, ttfb_min_ms, last_seen_at
      )
      select
        coalesce(a.provider_id, 0)                                          as provider_id,
        coalesce(a.provider_name, '')                                       as provider_name,
        coalesce(a.attempted_model, '(unspecified)')                        as model,
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
        coalesce(a.attempted_model, '(unspecified)'),
        substr(a.started_at, 1, 10)`,

    `drop table endpoint_health_daily`,
    `alter table endpoint_health_daily_new rename to endpoint_health_daily`,
    `create index if not exists idx_endpoint_health_day on endpoint_health_daily (day desc)`,
    `create index if not exists idx_endpoint_health_model on endpoint_health_daily (model, day desc)`,
  ],
};
