/**
 * 数字与时间的展示格式化。
 *
 * 取代旧 public/numbers.js 挂在 window 上的全局函数。
 * 纯函数、无副作用，首页与后台共用一套口径。
 */

const UNITS = [
  { limit: 1_000_000_000, suffix: 'B' },
  { limit: 1_000_000, suffix: 'M' },
  { limit: 1_000, suffix: 'K' },
];

/** 请求数一类的计数：万级以上压缩，避免面板数字换行 */
export function formatCount(value: number): string {
  const num = Number(value) || 0;
  if (num < 10_000) return num.toLocaleString('en-US');

  for (const unit of UNITS) {
    if (num >= unit.limit) {
      const scaled = num / unit.limit;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${unit.suffix}`;
    }
  }
  return String(num);
}

/** Token 量级通常更大，与计数同口径但单独命名以便日后分化 */
export function formatTokens(value: number): string {
  return formatCount(value);
}

export function formatPercent(value: number): string {
  return `${(Number(value) || 0).toFixed(1)}%`;
}

export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}