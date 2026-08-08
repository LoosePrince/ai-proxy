/**
 * 指标卡。
 *
 * 站点首页与后台概览共用同一个展示口径，避免同一个数字在两处
 * 用不同的格式化方式呈现（旧实现首页用 formatCount、后台直接 toLocaleString，
 * 同一个总请求数在两个页面看起来不一样）。
 */

import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'danger' | 'warning';
}) {
  return (
    <article className={`stat-card tone-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </article>
  );
}