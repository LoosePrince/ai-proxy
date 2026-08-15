import type {
  OutcomeBreakdown,
  ProviderUsageDTO,
  SuccessRates,
  UsageDailyDTO,
} from '@shared/api';

export interface WeeklyUsage {
  weekStart: string;
  /** 包含历史累计桶的原始周总量，仅用于数值展示与提示。 */
  requests: number;
  /** 该周可确认属于真实日期的请求量，用于视觉标尺。 */
  realRequests: number;
  /** 该周旧系统导入的历史累计请求量，仅用于识别与提示。 */
  historicalRequests: number;
  /** 该周是否混入了旧系统导入的历史累计。 */
  isHistorical: boolean;
  /** 原始周总量中的成功、失败和取消，用于提示。 */
  success: number;
  failed: number;
  /** 客户端取消单独成列：它既不是成功也不是失败，堆叠图需要第三段 */
  clientAbort: number;
  /** 仅真实日期的结果拆分，用于保留正常数据的彩色柱段。 */
  realSuccess: number;
  realClientAbort: number;
  totalTokens: number;
}

/**
 * 由分类计数派生成功率。与后端 usage.ts 的 successRatesOf 保持同一口径：
 *   交付率   缓存复用算成功，客户端取消不计入分母
 *   上游健康度 只统计真正打到上游的调用
 */
export function successRatesOf(breakdown: OutcomeBreakdown): SuccessRates {
  const delivered = breakdown.upstreamOk + breakdown.cacheHit;
  const attributable = Math.max(breakdown.requests - breakdown.clientAbort, 0);
  const upstreamCalls = breakdown.upstreamOk + breakdown.upstreamError;

  return {
    serviceSuccessRate: attributable > 0 ? (delivered / attributable) * 100 : 0,
    upstreamSuccessRate: upstreamCalls > 0 ? (breakdown.upstreamOk / upstreamCalls) * 100 : 0,
  };
}

export interface ChartSlice {
  label: string;
  value: number;
}

const EMPTY_DAILY = (day: string): UsageDailyDTO => ({
  day,
  isHistorical: false,
  requests: 0,
  success: 0,
  failed: 0,
  upstreamOk: 0,
  cacheHit: 0,
  upstreamError: 0,
  clientAbort: 0,
  rejected: 0,
  serviceSuccessRate: 0,
  upstreamSuccessRate: 0,
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

export interface DailySummary extends OutcomeBreakdown, SuccessRates {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
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
      requests: acc.requests + row.requests,
      upstreamOk: acc.upstreamOk + row.upstreamOk,
      cacheHit: acc.cacheHit + row.cacheHit,
      upstreamError: acc.upstreamError + row.upstreamError,
      clientAbort: acc.clientAbort + row.clientAbort,
      rejected: acc.rejected + row.rejected,
      promptTokens: acc.promptTokens + row.promptTokens,
      completionTokens: acc.completionTokens + row.completionTokens,
    }),
    {
      requests: 0,
      upstreamOk: 0,
      cacheHit: 0,
      upstreamError: 0,
      clientAbort: 0,
      rejected: 0,
      promptTokens: 0,
      completionTokens: 0,
    },
  );

  return {
    ...totals,
    ...successRatesOf(totals),
    totalRequests: totals.requests,
    successRequests: totals.upstreamOk + totals.cacheHit,
    failedRequests: totals.upstreamError + totals.rejected,
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
      realRequests: 0,
      historicalRequests: 0,
      isHistorical: false,
      success: 0,
      failed: 0,
      clientAbort: 0,
      realSuccess: 0,
      realClientAbort: 0,
      totalTokens: 0,
    };
    current.requests += row.requests;
    const success = row.upstreamOk + row.cacheHit;
    const failed = row.upstreamError + row.rejected;
    if (row.isHistorical) {
      current.isHistorical = true;
      current.historicalRequests += row.requests;
    } else {
      current.realRequests += row.requests;
      current.realSuccess += success;
      current.realClientAbort += row.clientAbort;
    }
    current.success += success;
    current.failed += failed;
    current.clientAbort += row.clientAbort;
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