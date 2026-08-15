import type { CSSProperties } from 'react';
import { Tooltip } from 'antd';

import { formatCount, formatPercent, formatTokens } from '../lib/format';
import type { ChartSlice, WeeklyUsage } from '../lib/analytics';
import type { UsageDailyDTO } from '@shared/api';
import './UsageCharts.css';

const SERIES_COLORS = [
  'var(--primary)',
  'var(--success)',
  'var(--warning)',
  'var(--accent)',
  'var(--danger)',
  'var(--text-faint)',
];

function EmptyChart() {
  return <div className="chart-empty">当前范围暂无数据</div>;
}

export function DonutChart({ slices }: { slices: ChartSlice[] }) {
  const total = slices.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <EmptyChart />;

  let cursor = 0;
  const stops = slices.map((slice, index) => {
    const from = cursor;
    cursor += (slice.value / total) * 100;
    return `${SERIES_COLORS[index % SERIES_COLORS.length]} ${from}% ${cursor}%`;
  });

  return (
    <div className="donut-layout">
      <div
        className="donut-chart"
        style={{ '--donut-fill': `conic-gradient(${stops.join(',')})` } as CSSProperties}
        role="img"
        aria-label={`请求分布，总计 ${total} 次`}
      >
        <div className="donut-center">
          <strong>{formatCount(total)}</strong>
          <span>请求</span>
        </div>
      </div>
      <div className="chart-legend">
        {slices.map((slice, index) => (
          <div className="chart-legend-item" key={slice.label}>
            <i style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
            <span title={slice.label}>{slice.label}</span>
            <strong>{formatPercent((slice.value / total) * 100)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Point {
  x: number;
  requestsY: number;
  rateY: number;
  row: UsageDailyDTO;
}

export function UsageTrendChart({ rows }: { rows: UsageDailyDTO[] }) {
  const active = rows.filter((row) => row.requests > 0);
  if (rows.length === 0 || active.length === 0) return <EmptyChart />;

  const width = 720;
  const height = 250;
  const padding = { left: 44, right: 44, top: 20, bottom: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const realRows = rows.filter((row) => !row.isHistorical);
  const maxRealRequests = Math.max(0, ...realRows.map((row) => row.requests));
  const maxRequests = Math.max(1, maxRealRequests);
  const displayedRequests = (row: UsageDailyDTO) =>
    row.isHistorical ? Math.min(row.requests, maxRealRequests) : row.requests;
  const xAt = (index: number) =>
    padding.left + (rows.length <= 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
  const points: Point[] = rows.map((row, index) => ({
    x: xAt(index),
    requestsY: padding.top + plotHeight - (displayedRequests(row) / maxRequests) * plotHeight,
    rateY: padding.top + plotHeight - (row.serviceSuccessRate / 100) * plotHeight,
    row,
  }));
  const segments = points.slice(1).map((to, index) => {
    const from = points[index]!;
    return { from, to, historical: from.row.isHistorical || to.row.isHistorical };
  });
  const requestAreaPaths = segments
    .filter((segment) => !segment.historical)
    .map(
      ({ from, to }) =>
        `M ${from.x} ${padding.top + plotHeight} L ${from.x} ${from.requestsY} L ${to.x} ${to.requestsY} L ${to.x} ${padding.top + plotHeight} Z`,
    );

  return (
    <div className="trend-chart-wrap">
      <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日请求和成功率趋势">
        <defs>
          <linearGradient id="requestArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.24" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + plotHeight * ratio;
          return (
            <g key={ratio}>
              <line className="chart-grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} />
              <text className="chart-axis-label" x={padding.left - 7} y={y + 3} textAnchor="end">
                {formatCount(Math.round(maxRequests * (1 - ratio)))}
              </text>
              <text className="chart-axis-label" x={width - padding.right + 7} y={y + 3}>
                {Math.round(100 * (1 - ratio))}%
              </text>
            </g>
          );
        })}
        {requestAreaPaths.map((path) => <path d={path} fill="url(#requestArea)" key={path} />)}
        {segments.map(({ from, to, historical }) => (
          <line
            className={`trend-line requests${historical ? ' historical' : ''}`}
            x1={from.x}
            x2={to.x}
            y1={from.requestsY}
            y2={to.requestsY}
            key={`requests-${to.row.day}`}
          />
        ))}
        {segments.map(({ from, to, historical }) => (
          <line
            className={`trend-line rate${historical ? ' historical' : ''}`}
            x1={from.x}
            x2={to.x}
            y1={from.rateY}
            y2={to.rateY}
            key={`rate-${to.row.day}`}
          />
        ))}
        {points.length <= 45
          ? points.map((point) => (
              <circle
                className={`trend-point${point.row.isHistorical ? ' historical' : ''}`}
                cx={point.x}
                cy={point.requestsY}
                r="3"
                key={point.row.day}
              >
                <title>
                  {`${point.row.day}：${point.row.requests} 次请求，交付率 ${formatPercent(point.row.serviceSuccessRate)}${point.row.isHistorical ? `。历史累计导入，图中请求高度按真实日最高 ${formatCount(maxRealRequests)} 次封顶` : ''}`}
                </title>
              </circle>
            ))
          : null}
        <text className="chart-axis-label" x={padding.left} y={height - 8}>{rows[0]!.day}</text>
        <text className="chart-axis-label" x={width - padding.right} y={height - 8} textAnchor="end">{rows.at(-1)!.day}</text>
      </svg>
      <div className="inline-chart-legend">
        <span><i className="legend-primary" />每日请求</span>
        <span><i className="legend-success" />交付率</span>
        {rows.some((row) => row.isHistorical) ? <span className="legend-historical"><i />历史累计（高度已封顶）</span> : null}
      </div>
    </div>
  );
}

function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.15) return 1;
  if (ratio <= 0.35) return 2;
  if (ratio <= 0.65) return 3;
  return 4;
}

export function CalendarHeatmap({ rows }: { rows: UsageDailyDTO[] }) {
  if (rows.length === 0) return <EmptyChart />;
  const visible = rows.slice(-371);
  const realMax = Math.max(0, ...visible.filter((row) => !row.isHistorical).map((row) => row.requests));
  const max = Math.max(1, realMax);
  const displayedRequests = (row: UsageDailyDTO) =>
    row.isHistorical ? Math.min(row.requests, realMax) : row.requests;
  const firstWeekday = new Date(`${visible[0]!.day}T00:00:00.000Z`).getUTCDay();
  const leading = firstWeekday === 0 ? 6 : firstWeekday - 1;
  const months = visible.flatMap((row, index) => {
    const previous = visible[index - 1];
    if (previous && previous.day.slice(0, 7) === row.day.slice(0, 7)) return [];
    return [{ label: `${Number(row.day.slice(5, 7))}月`, column: Math.floor((leading + index) / 7) + 1 }];
  });

  return (
    <div className="heatmap-wrap">
      <div className="heatmap-y-labels" aria-hidden="true"><span>周一</span><span>周三</span><span>周五</span></div>
      <div className="heatmap-scroll">
        <div className="heatmap-calendar">
          <div className="heatmap-months" aria-hidden="true">
            {months.map((month) => (
              <span key={`${month.label}-${month.column}`} style={{ gridColumnStart: month.column }}>{month.label}</span>
            ))}
          </div>
          <div className="heatmap-grid" role="img" aria-label="每日请求日历热力图">
          {Array.from({ length: leading }, (_, index) => <i className="heat-cell placeholder" key={`blank-${index}`} />)}
          {visible.map((row) => (
            <Tooltip
              key={row.day}
              title={`${row.day}：${formatCount(row.requests)} 次请求，${formatTokens(row.totalTokens)} Token${row.isHistorical ? `。历史累计导入，颜色强度按真实日最高 ${formatCount(realMax)} 次封顶` : ''}`}
              placement="top"
              autoAdjustOverflow
              mouseEnterDelay={0.08}
            >
              <i className={`heat-cell level-${heatLevel(displayedRequests(row), max)}${row.isHistorical ? ' historical' : ''}`} />
            </Tooltip>
          ))}
          </div>
        </div>
      </div>
      <div className="heatmap-legend">
        <span>少</span>{[0, 1, 2, 3, 4].map((level) => <i className={`heat-cell level-${level}`} key={level} />)}<span>多</span>
        {visible.some((row) => row.isHistorical) ? <span className="heatmap-historical"><i className="heat-cell historical" />历史累计</span> : null}
      </div>
    </div>
  );
}

export function WeeklyUsageChart({ weeks }: { weeks: WeeklyUsage[] }) {
  const visible = weeks.slice(-12);
  const realMax = Math.max(0, ...visible.map((week) => week.realRequests));
  const max = Math.max(1, realMax);
  if (visible.length === 0 || (realMax === 0 && !visible.some((week) => week.isHistorical))) return <EmptyChart />;

  return (
    <div className="weekly-chart" role="img" aria-label="最近十二周请求量">
      {visible.map((week) => {
        const normalHeight = (week.realRequests / max) * 100;
        // 历史累计没有可靠的时间粒度，灰段以正常数据等高占位，避免把累计量伪装成当周流量。
        const historicalHeight = week.isHistorical ? normalHeight : 0;
        const totalVisualHeight = normalHeight + historicalHeight;
        const normalShare = totalVisualHeight > 0 ? (normalHeight / totalVisualHeight) * 100 : 0;
        const historicalShare = totalVisualHeight > 0 ? (historicalHeight / totalVisualHeight) * 100 : 0;
        const shareOfNormal = (value: number) =>
          week.realRequests > 0 ? (value / week.realRequests) * normalShare : 0;
        const successHeight = shareOfNormal(week.realSuccess);
        const abortHeight = shareOfNormal(week.realClientAbort);
        const failedHeight = Math.max(normalShare - successHeight - abortHeight, 0);
        return (
          <div className={`week-column${week.isHistorical ? ' historical' : ''}`} key={week.weekStart}>
            <span className="week-value">{formatCount(week.requests)}</span>
            <div className="week-bar-track">
              <Tooltip
                title={`${week.weekStart} 起：${week.requests} 次，正常数据 ${week.realRequests} 次${week.isHistorical ? `，历史累计 ${week.historicalRequests} 次（灰段与正常数据等高）` : ''}，成功 ${week.success}，失败 ${week.failed}，客户端取消 ${week.clientAbort}`}
                placement="top"
                autoAdjustOverflow
                mouseEnterDelay={0.08}
              >
                <div className={`week-bar${week.isHistorical ? ' historical' : ''}`} style={{ height: `${totalVisualHeight}%` }}>
                  <i className="week-success" style={{ height: `${successHeight}%` }} />
                  <i className="week-aborted" style={{ height: `${abortHeight}%` }} />
                  <i className="week-failed" style={{ height: `${failedHeight}%` }} />
                  {week.isHistorical ? <i className="week-historical" style={{ height: `${historicalShare}%` }} /> : null}
                </div>
              </Tooltip>
            </div>
            <small>{week.weekStart.slice(5)}</small>
          </div>
        );
      })}
    </div>
  );
}