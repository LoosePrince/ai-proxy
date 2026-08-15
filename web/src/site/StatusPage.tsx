/**
 * 公开详细状态页 /status。
 *
 * 与首页三张卡的关系：首页回答「服务规模和能不能用」，这里回答「为什么是这个数」。
 * 因此本页的主线是把请求结局拆开展示，而不是再堆更多总量数字。
 *
 * 披露边界由后端把控：接口只返回聚合口径，不含 IP、Provider 名称与请求正文。
 * 后台开关关闭时接口返回 404，本页据此显示「未开放」而不是报错。
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Card, Empty, Skeleton, Table, Tooltip } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';

import { publicApi } from '../api/client';
import { SectionHead } from '../components/SectionHead';
import { StatCard } from '../components/StatCard';
import { UsageTrendChart } from '../components/UsageCharts';
import { useAsync } from '../hooks/useAsync';
import { formatCount, formatDateTime, formatPercent, formatTokens } from '../lib/format';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';
import type { PublicDailyStatsDTO, PublicModelStatsDTO, UsageDailyDTO } from '@shared/api';
import './site.css';

const REFRESH_MS = 60_000;

/**
 * 复用后台的趋势图组件，它以 UsageDailyDTO 为输入。
 * 公开 DTO 刻意不携带 token 明细拆分，这里补齐图表用不到的字段，
 * 避免为了公开页再复制一份 SVG 绘制逻辑。
 */
function toChartRow(row: PublicDailyStatsDTO): UsageDailyDTO {
  return {
    day: row.day,
    isHistorical: row.isHistorical,
    requests: row.requests,
    success: row.success,
    failed: row.failed,
    upstreamOk: row.success - row.cacheHit,
    cacheHit: row.cacheHit,
    upstreamError: row.failed,
    clientAbort: row.clientAbort,
    rejected: 0,
    serviceSuccessRate: row.serviceSuccessRate,
    upstreamSuccessRate: row.upstreamSuccessRate,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: row.totalTokens,
  };
}

function OutcomeTable({ rows }: { rows: PublicDailyStatsDTO[] }) {
  return (
    <Table<PublicDailyStatsDTO>
      rowKey="day"
      size="small"
      pagination={false}
      scroll={{ x: 'max-content', y: 420 }}
      dataSource={[...rows].reverse()}
      columns={[
        {
          title: '日期',
          dataIndex: 'day',
          width: 150,
          render: (value: string, row) => (
            <span className={row.isHistorical ? 'historical-day' : undefined}>
              {value}{row.isHistorical ? ' · 历史累计' : ''}
            </span>
          ),
        },
        { title: '请求', dataIndex: 'requests', align: 'right', render: formatCount },
        { title: '成功', dataIndex: 'success', align: 'right', render: formatCount },
        { title: '失败', dataIndex: 'failed', align: 'right', render: formatCount },
        {
          title: '复用缓存',
          dataIndex: 'cacheHit',
          align: 'right',
          render: formatCount,
        },
        {
          title: '客户端取消',
          dataIndex: 'clientAbort',
          align: 'right',
          render: formatCount,
        },
        {
          title: '交付率',
          dataIndex: 'serviceSuccessRate',
          align: 'right',
          render: (value: number) => formatPercent(value),
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

function ModelTable({ rows }: { rows: PublicModelStatsDTO[] }) {
  const total = rows.reduce((sum, row) => sum + row.requests, 0);

  return (
    <Table<PublicModelStatsDTO>
      rowKey="model"
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
      dataSource={rows}
      columns={[
        { title: '模型', dataIndex: 'model' },
        { title: '请求数', dataIndex: 'requests', align: 'right', render: formatCount },
        {
          title: '占比',
          align: 'right',
          render: (_: unknown, row) => formatPercent(total > 0 ? (row.requests / total) * 100 : 0),
        },
        { title: 'Token', dataIndex: 'totalTokens', align: 'right', render: formatTokens },
      ]}
    />
  );
}

export function StatusPage() {
  const stats = useAsync(() => publicApi.detailedStats(), []);

  useEffect(() => {
    const timer = setInterval(stats.reload, REFRESH_MS);
    return () => clearInterval(timer);
    // reload 是稳定引用，只需挂载时建立一次定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = stats.data;
  const overall = data?.overall;

  return (
    <div className="site">
      <SiteHeader />
      <main>
        <section className="section" aria-label="公开详细运行状态">
          <SectionHead
            kicker="Service status"
            title="详细运行状态"
            desc="近 30 天的请求结局分布。缓存复用与客户端取消单独成列，因此可以分开判断服务交付情况和上游健康程度。"
          />

          <p className="status-back">
            <Link to="/">
              <ArrowLeftOutlined /> 返回首页
            </Link>
          </p>

          {stats.status === 'error' ? (
            <Alert
              type="info"
              showIcon
              message="详细统计当前未开放"
              description="站点管理员可以在后台「全局设置 → 启用公开详细统计」中开放本页数据。"
            />
          ) : null}

          {stats.status === 'loading' && !data ? <Skeleton active paragraph={{ rows: 8 }} /> : null}

          {data && overall ? (
            <div className="stack">
              <div className="stat-grid status-metrics">
                <StatCard
                  label="交付率"
                  value={formatPercent(overall.serviceSuccessRate)}
                  hint="缓存复用计入成功，客户端取消不计入分母"
                  tone={overall.serviceSuccessRate >= 95 ? 'success' : 'warning'}
                />
                <StatCard
                  label="上游成功率"
                  value={formatPercent(overall.upstreamSuccessRate)}
                  hint={`只统计真正打到上游的 ${formatCount(overall.upstreamOk + overall.upstreamError)} 次调用`}
                  tone={overall.upstreamSuccessRate >= 95 ? 'success' : 'warning'}
                />
                <StatCard
                  label="请求总数"
                  value={formatCount(overall.requests)}
                  hint={`近 30 天 · ${formatTokens(data.totalTokens)} Token`}
                />
                <StatCard
                  label="在线 Provider"
                  value={formatCount(data.activeProviders)}
                  hint="参与路由的启用节点数量"
                />
              </div>

              <Card title="请求结局分布" bordered={false} className="status-card">
                <div className="outcome-grid">
                  <Tooltip title="真实调用上游并成功返回">
                    <div className="outcome-item tone-success">
                      <span>上游成功</span>
                      <strong>{formatCount(overall.upstreamOk)}</strong>
                    </div>
                  </Tooltip>
                  <Tooltip title="命中持久化缓存，本次未触达上游。算作成功交付。">
                    <div className="outcome-item tone-info">
                      <span>复用缓存</span>
                      <strong>{formatCount(overall.cacheHit)}</strong>
                    </div>
                  </Tooltip>
                  <Tooltip title="上游失败、超时或无可用 Provider">
                    <div className="outcome-item tone-danger">
                      <span>上游失败</span>
                      <strong>{formatCount(overall.upstreamError)}</strong>
                    </div>
                  </Tooltip>
                  <Tooltip title="客户端在响应完成前断开。既不算成功也不算失败，不计入成功率分母。">
                    <div className="outcome-item tone-muted">
                      <span>客户端取消</span>
                      <strong>{formatCount(overall.clientAbort)}</strong>
                    </div>
                  </Tooltip>
                  <Tooltip title="被网关自身拒绝，例如触发同 IP 限流。未触达上游。">
                    <div className="outcome-item tone-warning">
                      <span>网关拒绝</span>
                      <strong>{formatCount(overall.rejected)}</strong>
                    </div>
                  </Tooltip>
                </div>
              </Card>

              <Card title="近 30 天趋势" bordered={false} className="status-card">
                {data.daily.length > 0 ? (
                  <UsageTrendChart rows={data.daily.map(toChartRow)} />
                ) : (
                  <Empty description="暂无数据" />
                )}
              </Card>

              <Card title="每日明细" bordered={false} className="status-card">
                {data.daily.length > 0 ? <OutcomeTable rows={data.daily} /> : <Empty description="暂无数据" />}
              </Card>

              <Card title="模型用量" bordered={false} className="status-card">
                {data.models.length > 0 ? <ModelTable rows={data.models} /> : <Empty description="暂无数据" />}
              </Card>

              <p className="faint status-footnote">
                数据更新于 {formatDateTime(data.generatedAt)}，每 {REFRESH_MS / 1000} 秒自动刷新。
                本页只展示聚合口径，不包含访问来源、Provider 身份与请求内容。
              </p>
            </div>
          ) : null}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}