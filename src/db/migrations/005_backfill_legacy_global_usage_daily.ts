/**
 * 005 — 回填旧版全站累计的历史日桶。
 *
 * PostgreSQL 旧版统计只有 global_usage 单行累计值，没有逐请求时间戳。
 * import-pg 已把 Provider、模型和 IP 的同批历史统计放入一个历史日桶，
 * 但早期导入遗漏了 global_usage_daily，导致按范围查看核心指标时看不到累计值。
 *
 * 这里仅补齐 global_usage 与日表总和之间的正向差额，并归入现有维度表中最早的
 * 历史日；无法恢复的逐日分布不会被虚构。迁移只能执行一次，之后新请求继续按
 * 实际日期累计。
 */
export const migration005BackfillLegacyGlobalUsageDaily = {
  id: '005_backfill_legacy_global_usage_daily',
  statements: [
    `with
      daily_totals as (
        select
          coalesce(sum(requests), 0) as requests,
          coalesce(sum(success), 0) as success,
          coalesce(sum(failed), 0) as failed,
          coalesce(sum(prompt_tokens), 0) as prompt_tokens,
          coalesce(sum(completion_tokens), 0) as completion_tokens
        from global_usage_daily
      ),
      historical_day as (
        select coalesce(
          (
            select min(day) from (
              select day from provider_usage_daily
              union all select day from model_usage_daily
              union all select day from ip_usage_daily
            )
          ),
          strftime('%Y-%m-%d', 'now')
        ) as day
      )
    insert into global_usage_daily (
      day, requests, success, failed, prompt_tokens, completion_tokens
    )
    select
      historical_day.day,
      max(global_usage.requests - daily_totals.requests, 0),
      max(global_usage.success - daily_totals.success, 0),
      max(global_usage.failed - daily_totals.failed, 0),
      max(global_usage.prompt_tokens - daily_totals.prompt_tokens, 0),
      max(global_usage.completion_tokens - daily_totals.completion_tokens, 0)
    from global_usage
    cross join daily_totals
    cross join historical_day
    where global_usage.id = 1
      and (
        global_usage.requests > daily_totals.requests
        or global_usage.success > daily_totals.success
        or global_usage.failed > daily_totals.failed
        or global_usage.prompt_tokens > daily_totals.prompt_tokens
        or global_usage.completion_tokens > daily_totals.completion_tokens
      )
    on conflict(day) do update set
      requests = global_usage_daily.requests + excluded.requests,
      success = global_usage_daily.success + excluded.success,
      failed = global_usage_daily.failed + excluded.failed,
      prompt_tokens = global_usage_daily.prompt_tokens + excluded.prompt_tokens,
      completion_tokens = global_usage_daily.completion_tokens + excluded.completion_tokens`,
  ],
};