/**
 * 历史累计桶来源标记。
 *
 * 旧库只有累计统计，导入时被迫写入一个日期。这个日期不是实际发生日，
 * 因此需要显式保存来源，供展示层避免把它当成正常的日流量峰值。
 */
export const migrationHistoricalUsageProvenance = {
  id: 'historical_usage_provenance_20260810',
  statements: [
    `create table if not exists usage_daily_provenance (
      day text primary key references global_usage_daily(day) on delete cascade,
      kind text not null check (kind in ('historical_import')),
      created_at text not null
    )`,

    /*
     * 为已完成的旧库导入补标记。候选必须同时满足：
     * - 没有同日请求明细；
     * - 承载了全站累计量的至少 90%；
     * - 是时间序列中的首日。
     *
     * 三个条件共同成立才会标记，避免把普通高峰日误判成历史数据。
     */
    `insert or ignore into usage_daily_provenance (day, kind, created_at)
     select d.day, 'historical_import', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       from global_usage_daily d
       join global_usage g on g.id = 1
      where d.day = (select min(day) from global_usage_daily)
        and d.requests > 0
        and d.requests * 10 >= g.requests * 9
        and not exists (
          select 1 from requests r where substr(r.started_at, 1, 10) = d.day
        )`,
  ],
};