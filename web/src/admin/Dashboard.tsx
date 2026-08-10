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
import { Alert, Button, Card, Space, Spin, Table, Tag, Tooltip } from 'antd';

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
} from '../lib/analytics';
import { formatCount, formatDateTime, formatPercent, formatTokens } from '../lib/format';
import type { DashboardSummaryDTO, ProviderUsageDTO } from '@shared/api';

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
        { title: '上游调用', dataIndex: 'requests', align: 'right', render: formatCount },
        { title: '成功', dataIndex: 'upstreamOk', align: 'right', render: formatCount },
        { title: '失败', dataIndex: 'upstreamError', align: 'right', render: formatCount },
        {
          title: '客户端取消',
          dataIndex: 'clientAbort',
          align: 'right',
          render: (value: number) => (
            <Tooltip title="客户端在响应完成前断开。不计入成功率，避免把用户行为算成上游故障。">
              <span className={value > 0 ? 'faint' : undefined}>{formatCount(value)}</span>
            </Tooltip>
          ),
        },
        {
          title: '上游成功率',
          dataIndex: 'upstreamSuccessRate',
          align: 'right',
          render: (value: number) => formatPercent(value),
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
  const metricsUsage = useAsync(
    () => adminApi.dashboard(metricsRange.range),
    [metricsRange.range.from, metricsRange.range.to],
  );
  const pieUsage = useAsync(
    () => adminApi.providerUsage(pieRange.range),
    [pieRange.range.from, pieRange.range.to],
  );
  const tableUsage = useAsync(
    () => adminApi.providerUsage(tableRange.range),
    [tableRange.range.from, tableRange.range.to],
  );
  const runtime = useAsync(() => adminApi.runtime(), []);

  const metrics: DashboardSummaryDTO = metricsUsage.data ?? {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    requests: 0,
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
    providers: [],
  };
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
    metricsUsage.reload();
    pieUsage.reload();
    tableUsage.reload();
  };

  return (
    <div className="stack">
      {daily.status === 'error' || metricsUsage.status === 'error' || pieUsage.status === 'error' || tableUsage.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="用量数据加载失败"
          description={daily.error ?? metricsUsage.error ?? pieUsage.error ?? tableUsage.error}
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
        <StatCard
          label="总请求数"
          value={formatCount(metrics.totalRequests)}
          hint={`缓存复用 ${formatCount(metrics.cacheHit)} · 客户端取消 ${formatCount(metrics.clientAbort)}`}
        />
        <StatCard
          label="交付率"
          value={formatPercent(metrics.serviceSuccessRate)}
          hint={`缓存复用计入成功，客户端取消不计入分母（成功 ${formatCount(metrics.successRequests)} / 失败 ${formatCount(metrics.failedRequests)}）`}
          tone={metrics.serviceSuccessRate >= 95 ? 'success' : 'warning'}
        />
        <StatCard
          label="上游成功率"
          value={formatPercent(metrics.upstreamSuccessRate)}
          hint={`只统计真正打到上游的 ${formatCount(metrics.upstreamOk + metrics.upstreamError)} 次调用`}
          tone={metrics.upstreamSuccessRate >= 95 ? 'success' : 'warning'}
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
        <Alert
          type="info"
          showIcon
          className="mb-12"
          message="这里只统计真正发生的上游调用"
          description="命中缓存的请求不计入任何 Provider：缓存里的 Provider 本次并未被调用，计入会同时虚高它的请求数与成功率。客户端取消也不归属到 Provider。"
        />
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