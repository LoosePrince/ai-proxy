import type { ProviderUsageDTO, UsageDailyDTO } from '@shared/api';

export interface WeeklyUsage {
  weekStart: string;
  requests: number;
  success: number;
  failed: number;
  totalTokens: number;
}

export interface ChartSlice {
  label: string;
  value: number;
}

const EMPTY_DAILY = (day: string): UsageDailyDTO => ({
  day,
  requests: 0,
  success: 0,
  failed: 0,
  successRate: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  const date = parseDay(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return formatDay(date);
}

/** 补齐无请求日期，保证折线、周聚合和热力格使用同一条连续时间轴。 */
export function fillDailyGaps(
  rows: UsageDailyDTO[],
  bounds: { from?: string; to?: string } = {},
): UsageDailyDTO[] {
  const indexed = new Map(rows.map((row) => [row.day, row]));
  const sortedDays = [...indexed.keys()].sort();
  const from = bounds.from ?? sortedDays[0];
  const to = bounds.to ?? sortedDays.at(-1);
  if (!from || !to || from > to) return [];

  const result: UsageDailyDTO[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    result.push(indexed.get(day) ?? EMPTY_DAILY(day));
  }
  return result;
}

export interface DailySummary {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function filterDailyRange(
  rows: UsageDailyDTO[],
  range: { from?: string; to?: string },
): UsageDailyDTO[] {
  return rows.filter((row) => (!range.from || row.day >= range.from) && (!range.to || row.day <= range.to));
}

export function summarizeDaily(rows: UsageDailyDTO[]): DailySummary {
  const totals = rows.reduce(
    (acc, row) => ({
      totalRequests: acc.totalRequests + row.requests,
      successRequests: acc.successRequests + row.success,
      failedRequests: acc.failedRequests + row.failed,
      promptTokens: acc.promptTokens + row.promptTokens,
      completionTokens: acc.completionTokens + row.completionTokens,
    }),
    { totalRequests: 0, successRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0 },
  );
  return {
    ...totals,
    successRate: totals.totalRequests > 0 ? (totals.successRequests / totals.totalRequests) * 100 : 0,
    totalTokens: totals.promptTokens + totals.completionTokens,
  };
}

function mondayOf(day: string): string {
  const date = parseDay(day);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return formatDay(date);
}

export function aggregateWeekly(rows: UsageDailyDTO[]): WeeklyUsage[] {
  const weeks = new Map<string, WeeklyUsage>();
  for (const row of rows) {
    const weekStart = mondayOf(row.day);
    const current = weeks.get(weekStart) ?? {
      weekStart,
      requests: 0,
      success: 0,
      failed: 0,
      totalTokens: 0,
    };
    current.requests += row.requests;
    current.success += row.success;
    current.failed += row.failed;
    current.totalTokens += row.totalTokens;
    weeks.set(weekStart, current);
  }
  return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** 饼图最多保留主要项，长尾合并，防止图例无限增长。 */
export function providerRequestSlices(rows: ProviderUsageDTO[], limit = 6): ChartSlice[] {
  const sorted = rows
    .filter((row) => row.requests > 0)
    .map((row) => ({ label: row.name, value: row.requests }))
    .sort((a, b) => b.value - a.value);
  if (sorted.length <= limit) return sorted;

  const visible = sorted.slice(0, Math.max(1, limit - 1));
  return [
    ...visible,
    { label: '其他', value: sorted.slice(visible.length).reduce((sum, item) => sum + item.value, 0) },
  ];
}