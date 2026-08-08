/**
 * 后台概览。
 *
 * 两块数据来源不同，刻意分开请求：
 *   /admin/api/dashboard  业务用量（全站汇总 + provider 维度）
 *   /admin/api/runtime    进程内状态（配置快照、写队列、计数器、上游客户端）
 *
 * runtime 那块是这次重构新增的可观测面。旧实现没有任何窗口能看到
 * 「配置缓存是否生效」「落盘队列是否积压」，一旦写队列持续失败，
 * 表现只是统计数字不涨，无法区分是没流量还是写不进去。
 */

import { useMemo } from 'react';
import { Alert, Button, Card, Space, Spin, Table, Tag } from 'antd';

import { adminApi } from '../api/client';
import { DayRangeSelect, useDayRange } from '../components/DayRangePicker';
import { StatCard } from '../components/StatCard';
import { CalendarHeatmap, DonutChart, UsageTrendChart, WeeklyUsageChart } from '../components/UsageCharts';
import { useAsync } from '../hooks/useAsync';
import {
  aggregateWeekly,
  fillDailyGaps,
  filterDailyRange,
  providerRequestSlices,
  summarizeDaily,
} from '../lib/analytics';
import { formatCount, formatDateTime, formatPercent, formatTokens } from '../lib/format';
import type { ProviderUsageDTO } from '@shared/api';

const RUNTIME_REFRESH_MS = 15_000;

function ProviderUsageTable({ rows }: { rows: ProviderUsageDTO[] }) {
  return (
    <Table<ProviderUsageDTO>
      rowKey={(row) => `${row.providerId ?? 'deleted'}-${row.name}`}
      dataSource={rows}
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
      columns={[
        {
          title: 'Provider',
          dataIndex: 'name',
          render: (name: string, row) => (
            <Space size={6}>
              <span>{name}</span>
              {/* providerId 为 null 说明 provider 行已被删除，历史用量靠反规范化名称保留 */}
              {row.providerId === null ? <Tag color="default">已删除</Tag> : null}
              {row.kind !== 'primary' ? <Tag color="blue">{row.kind}</Tag> : null}
              {row.providerId !== null && !row.enabled ? <Tag color="orange">已停用</Tag> : null}
            </Space>
          ),
        },
        { title: '请求', dataIndex: 'requests', align: 'right', render: formatCount },
        { title: '成功', dataIndex: 'success', align: 'right', render: formatCount },
        { title: '失败', dataIndex: 'failed', align: 'right', render: formatCount },
        {
          title: '成功率',
          align: 'right',
          render: (_: unknown, row) =>
            formatPercent(row.requests > 0 ? (row.success / row.requests) * 100 : 0),
        },
        { title: 'Token', dataIndex: 'totalTokens', align: 'right', render: formatTokens },
      ]}
    />
  );
}

export function Dashboard() {
  const metricsRange = useDayRange('30d');
  const trendRange = useDayRange('30d');
  const pieRange = useDayRange('30d');
  const calendarRange = useDayRange('365d');
  const weekRange = useDayRange('90d');
  const tableRange = useDayRange('30d');

  // 日序列体量固定为“一天一行”，一次拉全量后由各板块独立切片，避免重复请求。
  const daily = useAsync(() => adminApi.dailyUsage(), []);
  const pieUsage = useAsync(
    () => adminApi.providerUsage(pieRange.range),
    [pieRange.range.from, pieRange.range.to],
  );
  const tableUsage = useAsync(
    () => adminApi.providerUsage(tableRange.range),
    [tableRange.range.from, tableRange.range.to],
  );
  const runtime = useAsync(() => adminApi.runtime(), []);

  const metrics = useMemo(
    () => summarizeDaily(filterDailyRange(daily.data ?? [], metricsRange.range)),
    [daily.data, metricsRange.range.from, metricsRange.range.to],
  );
  const trendRows = useMemo(
    () => fillDailyGaps(filterDailyRange(daily.data ?? [], trendRange.range), trendRange.range),
    [daily.data, trendRange.range.from, trendRange.range.to],
  );
  const calendarRows = useMemo(
    () => fillDailyGaps(filterDailyRange(daily.data ?? [], calendarRange.range), calendarRange.range),
    [daily.data, calendarRange.range.from, calendarRange.range.to],
  );
  const weeks = useMemo(
    () => aggregateWeekly(fillDailyGaps(filterDailyRange(daily.data ?? [], weekRange.range), weekRange.range)),
    [daily.data, weekRange.range.from, weekRange.range.to],
  );
  const providerSlices = useMemo(() => providerRequestSlices(pieUsage.data ?? []), [pieUsage.data]);
  const reloadUsage = () => {
    daily.reload();
    pieUsage.reload();
    tableUsage.reload();
  };

  return (
    <div className="stack">
      {daily.status === 'error' || pieUsage.status === 'error' || tableUsage.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="用量数据加载失败"
          description={daily.error ?? pieUsage.error ?? tableUsage.error}
          action={<Button onClick={reloadUsage}>重试</Button>}
        />
      ) : null}

      <div className="dashboard-section-head">
        <div>
          <strong>核心指标</strong>
          <span>请求、成功率与 Token 汇总</span>
        </div>
        <DayRangeSelect control={metricsRange.control} />
      </div>

      <div className="stat-grid">
        <StatCard label="总请求数" value={formatCount(metrics.totalRequests)} hint="选定范围内调用" />
        <StatCard
          label="成功率"
          value={formatPercent(metrics.successRate)}
          hint={`成功 ${formatCount(metrics.successRequests)} / 失败 ${formatCount(metrics.failedRequests)}`}
          tone={metrics.successRate >= 95 ? 'success' : 'warning'}
        />
        <StatCard
          label="总 Token"
          value={formatTokens(metrics.totalTokens)}
          hint={`Prompt ${formatTokens(metrics.promptTokens)} · Completion ${formatTokens(metrics.completionTokens)}`}
        />
      </div>

      <div className="chart-grid">
        <Card
          className="chart-card"
          title="请求趋势"
          extra={<DayRangeSelect control={trendRange.control} />}
        >
          {daily.status === 'loading' && !daily.data ? <Spin /> : <UsageTrendChart rows={trendRows} />}
        </Card>
        <Card
          className="chart-card"
          title="Provider 请求占比"
          extra={<DayRangeSelect control={pieRange.control} />}
        >
          {pieUsage.status === 'loading' && !pieUsage.data ? <Spin /> : <DonutChart slices={providerSlices} />}
        </Card>
        <Card
          className="chart-card"
          title="活跃日历"
          extra={<DayRangeSelect control={calendarRange.control} />}
        >
          {daily.status === 'loading' && !daily.data ? <Spin /> : <CalendarHeatmap rows={calendarRows} />}
        </Card>
        <Card
          className="chart-card"
          title="周视图"
          extra={<DayRangeSelect control={weekRange.control} />}
        >
          {daily.status === 'loading' && !daily.data ? <Spin /> : <WeeklyUsageChart weeks={weeks} />}
        </Card>
      </div>

      <Card
        title="Provider 用量"
        extra={
          <Space>
            <DayRangeSelect control={tableRange.control} />
            <Button size="small" onClick={tableUsage.reload}>刷新</Button>
          </Space>
        }
      >
        {tableUsage.status === 'loading' && !tableUsage.data ? (
          <Spin />
        ) : (
          <ProviderUsageTable rows={tableUsage.data ?? []} />
        )}
      </Card>

      <Card
        title="运行时状态"
        extra={
          <Space>
            <span className="faint">每 {RUNTIME_REFRESH_MS / 1000}s 可手动刷新</span>
            <Button size="small" onClick={runtime.reload}>
              刷新
            </Button>
          </Space>
        }
      >
        {runtime.data ? (
          <div className="runtime-grid">
            <StatCard
              label="配置快照"
              value={runtime.data.config.cached ? '已缓存' : '未加载'}
              hint={`${runtime.data.config.providerCount} 个 Provider · ${runtime.data.config.groupCount} 个优先级组`}
              tone={runtime.data.config.cached ? 'success' : 'warning'}
            />
            <StatCard
              label="快照时间"
              value={<span className="mono">{formatDateTime(runtime.data.config.loadedAt)}</span>}
              hint="配置写入后会失效并重建"
            />
            <StatCard
              label="写队列积压"
              value={formatCount(runtime.data.writeQueue.pending)}
              hint={`已落盘 ${formatCount(runtime.data.writeQueue.persisted)} · 丢弃 ${formatCount(runtime.data.writeQueue.dropped)}`}
              tone={runtime.data.writeQueue.pending > 500 || runtime.data.writeQueue.dropped > 0 ? 'danger' : 'success'}
            />
            <StatCard
              label="内存计数器"
              value={formatCount(runtime.data.counters.ipBuckets)}
              hint={`IP 限流桶 · 轮转游标 ${formatCount(runtime.data.counters.rotationCursors)}`}
            />
            <StatCard
              label="上游客户端"
              value={formatCount(runtime.data.upstreamClients)}
              hint="LRU 缓存中的 OpenAI 实例"
            />
            <StatCard
              label="运行时长"
              value={`${Math.floor(runtime.data.uptimeSec / 3600)}h ${Math.floor((runtime.data.uptimeSec % 3600) / 60)}m`}
              hint="进程启动至今"
            />
          </div>
        ) : (
          <Spin />
        )}

        {runtime.data?.writeQueue.lastError ? (
          <Alert
            className="mt-16"
            type="error"
            showIcon
            message="最近一次落盘失败"
            description={runtime.data.writeQueue.lastError}
          />
        ) : null}
      </Card>
    </div>
  );
}