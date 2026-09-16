/**
 * 状态监控。
 *
 * 回答的是「现在谁在坏、慢在哪」：渠道（Provider）与真实模型各自的可用率、
 * 延迟和逐日状态色条。数据来自 endpoint_health_daily 的日聚合，
 * 而聚合本身由真实请求的 attempt 记录累加而来 —— 这里没有任何主动探测，
 * 因此页面上的数字是「用户实际体验到的口径」，不是空载压测值：
 *
 *   - 对话延迟 / 7 天平均延迟：成功尝试的耗时；
 *   - 端点 PING：窗口内成功请求首字节的最小值，用来近似端点连通性；
 *   - 可用率：只统计真正打到上游的尝试，并行竞速落败（claimed-by-other）
 *     既不算成功也不算失败，不进分母。
 *
 * 状态判定在后端（endpoint-health.ts 的 classifyHealth），前端只负责上色：
 * 阈值只有一个来源，不会出现两个页面各有一套「正常」定义。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';

import { adminApi } from '../api/client';
import { StatCard } from '../components/StatCard';
import { useAsync } from '../hooks/useAsync';
import { formatCount, formatDateTime, formatMs, formatPercent } from '../lib/format';
import type {
  ChannelHealthDTO,
  ChannelModelHealthDTO,
  EndpointHealthSampleDTO,
  EndpointHealthState,
  ModelHealthDTO,
  ProviderKind,
} from '@shared/api';

/** 与公开状态页一致的刷新节奏；页面右上角会显示剩余秒数 */
const REFRESH_SECONDS = 60;

const STATE_LABEL: Record<EndpointHealthState, string> = {
  ok: '正常',
  slow: '延迟',
  degraded: '降级',
  error: '异常',
  down: '不可用',
  idle: '无流量',
};

/** 与阈值约定一致：绿 / 黄绿 / 黄 / 橙 / 红 / 灰 */
const STATE_COLOR: Record<EndpointHealthState, string> = {
  ok: 'green',
  slow: 'lime',
  degraded: 'gold',
  error: 'orange',
  down: 'red',
  idle: 'default',
};

const KIND_LABEL: Record<ProviderKind, string> = {
  primary: '主路由',
  fallback: '保底',
  parallel: '并行',
};

/** 毫秒值按图 2 的口径直接给整数，单位写在表头里 */
function formatMillis(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US');
}

function formatRate(value: number | null): string {
  return value === null ? '—' : formatPercent(value);
}

/**
 * 逐日状态色条。
 *
 * 用原生 title 而不是 antd Tooltip：30 天 × 每个渠道一个浮层组件，
 * 在渠道多的部署里是几百个监听器，而这里只需要「悬停看某一天」。
 */
function SampleBar({ samples }: { samples: EndpointHealthSampleDTO[] }) {
  return (
    <div className="sample-bar" role="img" aria-label="近 30 天逐日状态">
      {samples.map((sample) => (
        <i
          key={sample.day}
          className={`sample-cell state-${sample.state}`}
          title={`${sample.day}：${STATE_LABEL[sample.state]}${
            sample.availability === null ? '' : ` · 可用率 ${formatPercent(sample.availability)}`
          } · 上游尝试 ${formatCount(sample.attempts)} 次（成功 ${formatCount(sample.success)} / 失败 ${formatCount(sample.failed)}）`}
        />
      ))}
    </div>
  );
}

function StateTag({ state, tooltip }: { state: EndpointHealthState; tooltip?: string }) {
  const tag = <Tag color={STATE_COLOR[state]}>{STATE_LABEL[state]}</Tag>;
  return tooltip ? <Tooltip title={tooltip}>{tag}</Tooltip> : tag;
}

function channelTooltip(row: ChannelHealthDTO, windowDays: number): string {
  return [
    `近 ${windowDays} 天上游尝试 ${formatCount(row.attempts30d)} 次`,
    `最近 7 天：成功 ${formatCount(row.success7d)} / 失败 ${formatCount(row.failed7d)}`,
    `并行竞速落败 ${formatCount(row.claimed7d)} 次（不计入可用率分母）`,
    `最后活动：${formatDateTime(row.lastSeenAt)}`,
    row.enabled ? '' : '该渠道已停用',
  ]
    .filter(Boolean)
    .join('；');
}

function ChannelRow({
  row,
  windowDays,
  onOpen,
}: {
  row: ChannelHealthDTO;
  windowDays: number;
  onOpen: (providerId: number) => void;
}) {
  return (
    <div className="channel-row">
      <div className="channel-name">
        <Space size={6} wrap={false}>
          <strong>{row.displayName}</strong>
          {row.kind && row.kind !== 'primary' ? <Tag color="blue">{KIND_LABEL[row.kind]}</Tag> : null}
          {row.enabled ? null : <Tag color="orange">已停用</Tag>}
          {row.providerId === 0 ? <Tag>无归属</Tag> : null}
        </Space>
        <small>最后活动 {formatDateTime(row.lastSeenAt)}</small>
      </div>
      <div className="metric-cell">
        <span>对话延迟</span>
        <strong title={formatMs(row.latestLatencyMs)}>{formatMillis(row.latestLatencyMs)} ms</strong>
      </div>
      <div className="metric-cell">
        <span>端点 PING</span>
        <strong title={formatMs(row.pingMs)}>{formatMillis(row.pingMs)} ms</strong>
      </div>
      <div className="metric-cell">
        <span>可用性 · 7 天</span>
        <strong>{formatRate(row.availability7d)}</strong>
      </div>
      <div className="channel-samples">
        <SampleBar samples={row.samples} />
        <small className="faint">
          近 {windowDays} 天 · 7 天平均延迟 {formatMillis(row.avgLatency7d)} ms
        </small>
      </div>
      <div className="channel-state">
        <StateTag state={row.state} tooltip={channelTooltip(row, windowDays)} />
        <Button type="link" size="small" onClick={() => onOpen(row.providerId)} disabled={row.providerId <= 0}>
          模型状态
        </Button>
      </div>
    </div>
  );
}

/**
 * 渠道弹窗：该渠道声明的全部模型（含已停用）逐个展示状态，
 * 并可直接停用/恢复 —— 停用 = 路由视为无该模型。
 */
function ChannelModelDrawer({
  providerId,
  channelName,
  open,
  onClose,
}: {
  providerId: number | null;
  channelName: string;
  open: boolean;
  onClose: () => void;
}) {
  const health = useAsync(() => (providerId === null ? Promise.resolve(null) : adminApi.providerModelHealth(providerId)), [providerId, open]);
  const [toggling, setToggling] = useState<string | null>(null);

  const toggle = async (model: string, enabled: boolean) => {
    if (providerId === null) return;
    setToggling(model);
    try {
      await adminApi.setProviderModelEnabled(providerId, model, enabled);
      message.success(enabled ? `已恢复模型 ${model}` : `已停用模型 ${model}（路由视为无该模型）`);
      health.reload();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setToggling(null);
    }
  };

  const data = health.data as ChannelModelHealthDTO | null;

  return (
    <Drawer
      title={`渠道模型状态 · ${channelName}`}
      open={open}
      onClose={onClose}
      width={860}
      destroyOnClose
    >
      {health.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="模型状态加载失败"
          description={health.error}
          action={<Button onClick={health.reload}>重试</Button>}
        />
      ) : null}
      {health.status === 'loading' ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
      {data ? (
        <>
          <Table<ModelHealthDTO>
            rowKey="model"
            size="small"
            pagination={data.models.length > 20 ? { pageSize: 20, hideOnSinglePage: true } : false}
            scroll={{ x: 'max-content' }}
            dataSource={data.models}
            expandable={{
              expandedRowRender: (row) => (
                <div className="model-samples">
                  <SampleBar samples={row.samples} />
                  <small className="faint">
                    近 30 天上游尝试 {formatCount(row.attempts30d)} 次 · 最近 7 天 {formatCount(row.attempts7d)} 次 ·
                    最后活动 {formatDateTime(row.lastSeenAt)}
                  </small>
                </div>
              ),
              rowExpandable: () => true,
            }}
            columns={[
              {
                title: '模型',
                dataIndex: 'model',
                render: (model: string, row) => (
                  <Space size={6}>
                    <span
                      style={
                        row.providerCount === 0
                          ? { color: '#8c8c8c' }
                          : row.disabled
                            ? { textDecoration: 'line-through', opacity: 0.55 }
                            : undefined
                      }
                    >
                      {model}
                    </span>
                    {row.providerCount === 0 ? <Tag color="default">历史模型</Tag> : null}
                    {row.disabled && row.providerCount > 0 ? <Tag color="orange">已停用</Tag> : null}
                  </Space>
                ),
              },
              {
                title: '最新状态',
                dataIndex: 'state',
                width: 110,
                render: (state: EndpointHealthState, row) => (
                  <StateTag
                    state={state}
                    tooltip={
                      row.disabled
                        ? '已停用：不再参与路由；恢复后立即可用'
                        : `最近 7 天上游尝试 ${formatCount(row.attempts7d)} 次`
                    }
                  />
                ),
              },
              {
                title: '最新延迟 (MS)',
                dataIndex: 'latestLatencyMs',
                align: 'right',
                render: (value: number | null) => <Tooltip title={formatMs(value)}>{formatMillis(value)}</Tooltip>,
              },
              {
                title: '7 天可用率',
                dataIndex: 'availability7d',
                align: 'right',
                render: (value: number | null) => formatRate(value),
              },
              {
                title: '30 天可用率',
                dataIndex: 'availability30d',
                align: 'right',
                render: (value: number | null) => formatRate(value),
              },
              {
                title: '7 天平均延迟 (MS)',
                dataIndex: 'avgLatency7d',
                align: 'right',
                render: (value: number | null) => <Tooltip title={formatMs(value)}>{formatMillis(value)}</Tooltip>,
              },
              {
                title: '启用',
                key: 'enabled',
                width: 90,
                render: (_: unknown, row) => (
                  <Switch
                    size="small"
                    checked={!row.disabled}
                    loading={toggling === row.model}
                    onChange={(checked) => void toggle(row.model, checked)}
                  />
                ),
              },
            ]}
          />
          <p className="faint">
            数据更新于 {formatDateTime(data.generatedAt)}。列表覆盖该渠道声明的全部模型（含已停用）：
            模型状态按「站点通过渠道声明模型发起请求」的口径统计，不使用客户端自定义填写的模型名，
            也不使用上游响应返回的实际模型名。
          </p>
        </>
      ) : null}
    </Drawer>
  );
}

export function Monitor() {
  const health = useAsync(() => adminApi.endpointHealth(), []);
  const windowDays = health.data?.windowDays ?? 30;

  // 倒计时：手动刷新后重新计时，因此以「最近一次成功加载的时间」为准
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_SECONDS);
  const lastLoadRef = useRef(Date.now());
  const loadingRef = useRef(false);
  const reloadRef = useRef(health.reload);
  reloadRef.current = health.reload;

  useEffect(() => {
    if (health.status === 'loading') {
      loadingRef.current = true;
      return;
    }
    loadingRef.current = false;
    if (health.status === 'success') lastLoadRef.current = Date.now();
  }, [health.status, health.data]);

  useEffect(() => {
    const timer = setInterval(() => {
      const left = Math.max(REFRESH_SECONDS - Math.floor((Date.now() - lastLoadRef.current) / 1000), 0);
      setSecondsLeft(left);
      // 只在没有请求在飞的时候触发，避免失败时每秒重发
      if (left === 0 && !loadingRef.current) {
        loadingRef.current = true;
        reloadRef.current();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const channels = health.data?.channels ?? [];
  const models = health.data?.models ?? [];

  // 渠道弹窗：查看该渠道声明的全部模型状态并可停用
  const [drawerProviderId, setDrawerProviderId] = useState<number | null>(null);
  const drawerProvider = channels.find((row) => row.providerId === drawerProviderId) ?? null;

  const counts = useMemo(() => {
    const byState: Record<EndpointHealthState, number> = { ok: 0, slow: 0, degraded: 0, error: 0, down: 0, idle: 0 };
    for (const row of channels) byState[row.state] += 1;
    return byState;
  }, [channels]);

  return (
    <div className="stack">
      {health.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="状态数据加载失败"
          description={health.error}
          action={<Button onClick={health.reload}>重试</Button>}
        />
      ) : null}

      <div className="stat-grid">
        <StatCard
          label="正常渠道"
          value={`${counts.ok} / ${channels.length}`}
          hint="近 7 天可用率 ≥ 95% 的渠道数量"
          tone={counts.ok > 0 && counts.down + counts.error + counts.degraded + counts.slow === 0 ? 'success' : 'default'}
        />
        <StatCard
          label="非正常渠道"
          value={counts.slow + counts.degraded + counts.error + counts.down}
          hint="延迟（≥85%）+ 降级（≥60%）+ 异常（≥30%）+ 不可用（<30%）之和，近 7 天口径"
          tone={counts.slow + counts.degraded + counts.error + counts.down > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="不可用渠道"
          value={counts.down}
          hint="近 7 天可用率 < 30%"
          tone={counts.down > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label="监控对象"
          value={`${channels.length} 渠道 / ${models.length} 模型`}
          hint="包含零流量对象，长期无请求会显示为「无流量」"
        />
      </div>

      <Card
        title="渠道状态"
        extra={
          <Space>
            <span className="faint">{secondsLeft}S 后刷新</span>
            <Button size="small" onClick={health.reload}>
              刷新
            </Button>
          </Space>
        }
      >
        {channels.length === 0 && health.status === 'loading' ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : channels.length === 0 ? (
          <Empty description="暂无渠道数据" />
        ) : (
          <>
            <div className="sample-legend">
              <span className="faint">近 {windowDays} 天逐日状态</span>
              {(['ok', 'slow', 'degraded', 'error', 'down', 'idle'] as EndpointHealthState[]).map((state) => (
                <span key={state}>
                  <i className={`sample-cell state-${state}`} />
                  {STATE_LABEL[state]}
                </span>
              ))}
            </div>
            <div className="channel-table">
              <div className="channel-row channel-head">
                <div>渠道</div>
                <div>对话延迟</div>
                <div>端点 PING</div>
                <div>可用性 · 7 天</div>
                <div className="channel-samples">逐日状态</div>
                <div className="channel-state">状态</div>
              </div>
              {channels.map((row) => (
                <ChannelRow
                  key={`${row.providerId}-${row.name}`}
                  row={row}
                  windowDays={windowDays}
                  onOpen={setDrawerProviderId}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <Card
        title="模型状态"
        extra={
          <Tooltip title="延迟只取成功尝试；可用率只统计真正打到上游的调用，并行竞速落败不计入分母。">
            <span className="faint">按状态严重度排序</span>
          </Tooltip>
        }
      >
        {models.length === 0 && health.status === 'loading' ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : models.length === 0 ? (
          <Empty description="暂无模型数据" />
        ) : (
          <Table<ModelHealthDTO>
            rowKey="model"
            size="small"
            pagination={models.length > 20 ? { pageSize: 20, hideOnSinglePage: true } : false}
            scroll={{ x: 'max-content' }}
            dataSource={models}
            expandable={{
              expandedRowRender: (row) => (
                <div className="model-samples">
                  <SampleBar samples={row.samples} />
                  <small className="faint">
                    近 {windowDays} 天上游尝试 {formatCount(row.attempts30d)} 次 · 最近 7 天 {formatCount(row.attempts7d)} 次 ·
                    最后活动 {formatDateTime(row.lastSeenAt)}
                  </small>
                </div>
              ),
              rowExpandable: () => true,
            }}
            columns={[
              {
                title: '模型',
                dataIndex: 'model',
                render: (model: string, row) => (
                  <Space size={6}>
                    <span style={row.providerCount === 0 ? { color: '#8c8c8c' } : undefined}>{model}</span>
                    {row.providerCount === 0 ? <Tag color="default">历史模型</Tag> : null}
                    {row.attempts30d === 0 && row.providerCount > 0 ? <Tag>仅缓存命中</Tag> : null}
                  </Space>
                ),
              },
              {
                title: '最新状态',
                dataIndex: 'state',
                render: (state: EndpointHealthState, row) => (
                  <StateTag
                    state={state}
                    tooltip={`最近 7 天上游尝试 ${formatCount(row.attempts7d)} 次 · 最后活动 ${formatDateTime(row.lastSeenAt)}`}
                  />
                ),
              },
              {
                title: '最新延迟 (MS)',
                dataIndex: 'latestLatencyMs',
                align: 'right',
                render: (value: number | null) => (
                  <Tooltip title={formatMs(value)}>{formatMillis(value)}</Tooltip>
                ),
              },
              {
                title: '7 天可用率',
                dataIndex: 'availability7d',
                align: 'right',
                render: (value: number | null) => formatRate(value),
              },
              {
                title: '15 天可用率',
                dataIndex: 'availability15d',
                align: 'right',
                render: (value: number | null) => formatRate(value),
              },
              {
                title: '30 天可用率',
                dataIndex: 'availability30d',
                align: 'right',
                render: (value: number | null) => formatRate(value),
              },
              {
                title: '7 天平均延迟 (MS)',
                dataIndex: 'avgLatency7d',
                align: 'right',
                render: (value: number | null) => (
                  <Tooltip title={formatMs(value)}>{formatMillis(value)}</Tooltip>
                ),
              },
            ]}
          />
        )}
      </Card>

      <p className="faint">
        数据更新于 {formatDateTime(health.data?.generatedAt ?? null)}，每 {REFRESH_SECONDS} 秒自动刷新。
        全部指标由真实请求的尝试记录聚合而来，不含主动探测：「端点 PING」是窗口内成功请求首字节的最小值，
        作为端点连通延迟的近似；可用率只统计真正打到上游的调用，并行竞速落败与缓存命中都不进分母。
        模型列表与状态按「站点通过渠道声明模型发起请求」的口径统计，渠道弹窗内可停用单个模型（路由视为无该模型）。
      </p>

      <ChannelModelDrawer
        providerId={drawerProviderId}
        channelName={drawerProvider?.displayName ?? drawerProvider?.name ?? ''}
        open={drawerProviderId !== null}
        onClose={() => setDrawerProviderId(null)}
      />
    </div>
  );
}
