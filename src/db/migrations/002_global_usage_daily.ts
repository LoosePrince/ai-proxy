/**
 * 002_global_usage_daily — 全站时间序列。
 *
 * Provider 日聚合无法覆盖“所有 Provider 均失败、没有 finalProviderId”的请求，
 * 模型日聚合又没有成功/失败维度。独立的全站日聚合让趋势、热力与周视图共享
 * 同一份完整数据，并且不受请求明细保留策略影响。
 */

export const migration002GlobalUsageDaily = {
  id: '002_global_usage_daily',
  statements: [
    `create table if not exists global_usage_daily (
      day text primary key,
      requests integer not null default 0,
      success integer not null default 0,
      failed integer not null default 0,
      prompt_tokens integer not null default 0,
      completion_tokens integer not null default 0
    )`,
    `insert or ignore into global_usage_daily (
      day, requests, success, failed, prompt_tokens, completion_tokens
    )
    select
      substr(started_at, 1, 10),
      count(*),
      sum(case when success = 1 then 1 else 0 end),
      sum(case when success = 1 then 0 else 1 end),
      sum(prompt_tokens),
      sum(completion_tokens)
    from requests
    group by substr(started_at, 1, 10)`,
  ],
};