/**
 * 请求日志。
 *
 * 这是本次重构收益最直接的一页。旧实现的日志是内存数组、上限 200 条、
 * 重启即丢，且 attempts 里存的是 routeTrace 的活引用——后续尝试会追溯改写
 * 已经写入的历史记录。现在日志是 requests / request_attempts 两张持久表，
 * 服务端分页筛选，attempts 在写入时已是不可变快照。
 *
 * 筛选条件放在 URL 上，因此「某个 IP 的失败请求」这类视图可以直接分享链接，
 * 也让 IP 统计页能带参数跳进来。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Descriptions, Drawer, Input, Menu, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Timeline, Tooltip, Typography, message } from 'antd';
import type { MenuProps } from 'antd';
import ReactMarkdown from 'react-markdown';

import { adminApi } from '../api/client';
import { DayRangePicker, useDayRange } from '../components/DayRangePicker';
import { useAsync } from '../hooks/useAsync';
import { formatCount, formatDateTime, formatMs, formatPercent, formatTokens } from '../lib/format';
import type {
  AttemptStatus,
  IpDetailStatsDTO,
  RequestListQuery,
  RequestOutcome,
  RequestSummaryDTO,
} from '@shared/api';

const PAGE_SIZE = 20;

/**
 * 结局分类的展示口径。
 *
 * 之所以直接展示分类而不是「成功/失败」两态：缓存复用与客户端取消
 * 在旧口径下分别被塞进成功与失败，排查时无法区分「上游真的坏了」
 * 和「用户自己按了停止」。
 */
const OUTCOME_VIEW: Record<RequestOutcome, { label: string; color: string; hint: string }> = {
  upstream_ok: { label: '成功', color: 'green', hint: '真实调用上游并成功返回' },
  cache_hit: { label: '复用缓存', color: 'blue', hint: '命中持久化缓存，本次未触达上游' },
  upstream_error: { label: '上游失败', color: 'red', hint: '上游失败、超时或无可用 Provider' },
  client_abort: {
    label: '客户端取消',
    color: 'default',
    hint: '客户端在响应完成前断开。不计入成功率，也不归属到任何 Provider。',
  },
  rejected: { label: '网关拒绝', color: 'orange', hint: '被网关自身拒绝（如限流），未触达上游' },
};

const OUTCOME_FILTER_OPTIONS = (Object.keys(OUTCOME_VIEW) as RequestOutcome[]).map((outcome) => ({
  label: OUTCOME_VIEW[outcome].label,
  value: outcome,
}));

const STATUS_COLOR: Record<AttemptStatus, string> = {
  success: 'green',
  failed: 'red',
  // 被更快的 provider 抢占不是故障，用中性色区分
  'claimed-by-other': 'default',
};

const STATUS_LABEL: Record<AttemptStatus, string> = {
  success: '成功',
  failed: '失败',
  'claimed-by-other': '被抢占',
};

const ROLE_LABEL: Record<string, string> = {
  primary: '主链',
  parallel: '并行',
  fallback: '保底',
};

function formatContent(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return '';
      return typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : '';
    })
    .join('');
}

function extractSseText(body: string): string {
  const parts: string[] = [];
  for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const event = JSON.parse(data) as unknown;
      if (!isRecord(event)) continue;
      if (typeof event.delta === 'string' && ['response.output_text.delta', 'response.reasoning.delta'].includes(String(event.type))) {
        parts.push(event.delta);
        continue;
      }
      const choices = Array.isArray(event.choices) ? event.choices : [];
      const delta = isRecord(choices[0]) && isRecord(choices[0].delta) ? choices[0].delta : null;
      if (delta) {
        if (typeof delta.content === 'string') parts.push(delta.content);
        else if (typeof delta.reasoning_content === 'string') parts.push(delta.reasoning_content);
        else if (typeof delta.reasoning === 'string') parts.push(delta.reasoning);
      }
    } catch {
      // 非 JSON 的 SSE 心跳或上游自定义事件不会产生可渲染正文。
    }
  }
  return parts.join('');
}

function extractMessagesText(value: unknown): string {
  const messages = isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  return messages
    .map((message) => {
      if (!isRecord(message)) return '';
      const content = contentToText(message.content);
      return content ? `### ${typeof message.role === 'string' ? message.role : 'message'}\n\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function extractResponseText(value: unknown): string {
  if (typeof value === 'string') return extractSseText(value) || value;
  if (!isRecord(value)) return '';

  const choices = Array.isArray(value.choices) ? value.choices : [];
  const choiceMessage = isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : null;
  if (choiceMessage) return contentToText(choiceMessage.content) || String(choiceMessage.reasoning_content ?? '');

  const output = Array.isArray(value.output) ? value.output : [];
  const outputText = output
    .filter((item) => isRecord(item) && item.type === 'message')
    .map((item) => (isRecord(item) ? contentToText(item.content) : ''))
    .join('');
  return outputText || (typeof value.output_text === 'string' ? value.output_text : '');
}

function extractRenderableContent(value: unknown, type: 'request' | 'response'): string {
  if (type === 'response') return extractResponseText(value);
  const messages = extractMessagesText(value);
  if (messages) return messages;
  if (isRecord(value)) {
    if (typeof value.input === 'string') return value.input;
    if (Array.isArray(value.input)) {
      return value.input
        .map((item) => (isRecord(item) ? contentToText(item.content) : ''))
        .filter(Boolean)
        .join('\n\n');
    }
  }
  return typeof value === 'string' ? value : '';
}

function ContentLogSection({ title, value, type }: { title: string; value: unknown; type: 'request' | 'response' }) {
  const [view, setView] = useState<'raw' | 'render'>('raw');
  const rendered = useMemo(() => extractRenderableContent(value, type), [type, value]);

  return (
    <section>
      <div className="content-log-heading">
        <strong>{title}</strong>
        <Tabs
          activeKey={view}
          size="small"
          onChange={(key) => setView(key as 'raw' | 'render')}
          items={[
            { key: 'raw', label: '原始内容' },
            { key: 'render', label: '渲染模式' },
          ]}
        />
      </div>
      {view === 'raw' ? (
        <pre className="content-log-body">{formatContent(value)}</pre>
      ) : (
        <div className="content-rendered-body">
          {rendered ? <ReactMarkdown>{rendered}</ReactMarkdown> : '未从此记录中提取到可渲染的文本内容。'}
        </div>
      )}
    </section>
  );
}

export function RequestLogs() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<number | null>(null);
  const logRange = useDayRange('all');
  const providers = useAsync(() => adminApi.providers(), []);

  useEffect(() => {
    setPage(1);
  }, [logRange.range.from, logRange.range.to]);

  // URL 保存可分享的离散筛选（多选值以逗号编码）；日期范围由统一范围控件管理。
  const query = useMemo<RequestListQuery>(() => {
    const success = params.get('success');
    const result: RequestListQuery = {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    if (success === 'true') result.success = true;
    if (success === 'false') result.success = false;
    const outcomes = (params.get('outcomes') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item): item is RequestOutcome => item in OUTCOME_VIEW);
    if (outcomes.length > 0) result.outcomes = outcomes;
    const model = params.get('requestedModel');
    if (model) result.requestedModel = model;
    const ip = params.get('ip');
    if (ip) result.ip = ip;
    const providerIds = (params.get('providerIds') ?? '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (providerIds.length > 0) result.providerIds = providerIds;
    if (logRange.range.from) result.from = `${logRange.range.from}T00:00:00.000Z`;
    if (logRange.range.to) result.to = `${logRange.range.to}T23:59:59.999Z`;
    return result;
  }, [params, page, logRange.range.from, logRange.range.to]);

  const list = useAsync(
    () => adminApi.requests(query),
    [
      query.limit,
      query.offset,
      query.success,
      query.outcomes?.join(','),
      query.requestedModel,
      query.ip,
      query.providerIds?.join(','),
      query.from,
      query.to,
    ],
  );

  const detail = useAsync(
    () => (detailId === null ? Promise.resolve(null) : adminApi.requestDetail(detailId)),
    [detailId],
  );

  // 多选控件的受控值从 URL 派生，保证分享链接与刷新后状态一致
  const selectedOutcomes = useMemo(
    () => query.outcomes ?? [],
    [query.outcomes],
  );
  const selectedProviderIds = useMemo(
    () => (query.providerIds ?? []).map(String),
    [query.providerIds],
  );

  /** 改筛选条件时回到第一页，否则可能停在一个空页上 */
  const patchFilter = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
      setPage(1);
    },
    [params, setParams],
  );

  // ---------------------------------------------------------------- 行右键菜单

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: RequestSummaryDTO } | null>(null);
  const [banTarget, setBanTarget] = useState<string | null>(null);
  const [banNote, setBanNote] = useState('');
  const [banning, setBanning] = useState(false);
  const [statsIp, setStatsIp] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  /*
   * 点击 / 再次右键菜单外、滚动、resize 时关闭菜单。
   * 注意用 capture 捕获窗口右键：若不拦截，onContextMenu 里的 preventDefault
   * 只阻止默认菜单，而这里负责在别处右键时收起本菜单。
   * 菜单内部的点击不会关闭自己（stopPropagation 由 Menu 项的 onClick 处理）。
   */
  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeContextMenu();
    };
    window.addEventListener('pointerdown', closeOnPointerDown, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, true);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('blur', closeContextMenu);
    };
  }, [contextMenu, closeContextMenu]);

  const quickBan = async () => {
    if (!banTarget) return;
    setBanning(true);
    try {
      await adminApi.addIpBlacklist(banTarget, banNote.trim() || null);
      message.success(`IP ${banTarget} 已加入黑名单`);
      setBanTarget(null);
      setBanNote('');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBanning(false);
    }
  };

  const contextMenuItems: MenuProps['items'] = useMemo(() => {
    if (!contextMenu) return [];
    const { row } = contextMenu;
    const ipDisabled = !row.ip;
    return [
      {
        key: 'filter-ip',
        label: row.ip ? `筛选此 IP（${row.ip}）` : '筛选此 IP（无 IP）',
        disabled: ipDisabled,
        onClick: () => {
          patchFilter('ip', row.ip);
          closeContextMenu();
        },
      },
      {
        key: 'ban',
        label: '快速封禁此 IP',
        disabled: ipDisabled,
        danger: true,
        onClick: () => {
          setBanNote('');
          setBanTarget(row.ip);
          closeContextMenu();
        },
      },
      { type: 'divider' as const },
      {
        key: 'stats',
        label: '查看统计信息',
        disabled: ipDisabled,
        onClick: () => {
          setStatsIp(row.ip);
          closeContextMenu();
        },
      },
    ];
  }, [contextMenu, patchFilter, closeContextMenu]);

  // 统计 Drawer 的数据源：沿用日志页当前的时间筛选，保证口径一致
  const statsRange = useMemo(
    () => ({
      from: logRange.range.from ?? undefined,
      to: logRange.range.to ?? undefined,
    }),
    [logRange.range.from, logRange.range.to],
  );
  const ipStats = useAsync(
    () => (statsIp === null ? Promise.resolve(null) : adminApi.ipStats(statsIp, statsRange)),
    [statsIp, statsRange.from, statsRange.to],
  );

  return (
    <div className="stack">
      {contextMenu ? (
        /*
          右键菜单：不用 Dropdown 锚点方案（0×0 锚点 + 受控 open 在部分浏览器
          下定位与关闭时序都不稳定），直接用 fixed 定位渲染 Menu，坐标取自
          右键事件本身，并防止菜单贴出视口。
        */
        <div
          ref={menuRef}
          className="row-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <Menu onClick={closeContextMenu} items={contextMenuItems} selectable={false} />
        </div>
      ) : null}

      {list.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="请求日志加载失败"
          description={list.error}
          action={<Button onClick={list.reload}>重试</Button>}
        />
      ) : null}

      <Card
        title="请求日志"
        extra={
          <Space wrap>
            <DayRangePicker {...logRange.control} />
            <Select
              size="small"
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              className="control-w-200"
              placeholder="全部 Provider"
              value={selectedProviderIds}
              loading={providers.status === 'loading'}
              onChange={(value) =>
                patchFilter('providerIds', value.length > 0 ? value.join(',') : null)
              }
              options={(providers.data ?? []).map((provider) => ({
                label: provider.displayName || provider.name,
                value: String(provider.id),
              }))}
            />
            <Select
              size="small"
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              className="control-w-200"
              placeholder="全部结局"
              value={selectedOutcomes}
              onChange={(value) => patchFilter('outcomes', value.length > 0 ? value.join(',') : null)}
              options={OUTCOME_FILTER_OPTIONS}
            />
            <Input.Search
              size="small"
              allowClear
              placeholder="请求模型"
              className="control-w-160"
              defaultValue={params.get('requestedModel') ?? ''}
              onSearch={(value) => patchFilter('requestedModel', value || null)}
            />
            <Input.Search
              size="small"
              allowClear
              placeholder="IP"
              className="control-w-150"
              defaultValue={params.get('ip') ?? ''}
              onSearch={(value) => patchFilter('ip', value || null)}
            />
            <Button size="small" onClick={list.reload}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<RequestSummaryDTO>
          rowKey="id"
          size="small"
          scroll={{ x: 'max-content' }}
          loading={list.status === 'loading'}
          dataSource={list.data?.items ?? []}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: list.data?.total ?? 0,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 条`,
            onChange: setPage,
          }}
          onRow={(row) => ({
            onClick: () => setDetailId(row.id),
            onContextMenu: (event) => {
              // 只拦截表格行上的右键，表头等区域不受影响
              event.preventDefault();
              event.stopPropagation();
              // 限制坐标避免菜单贴视口右/下边缘时被裁掉
              const x = Math.min(event.clientX, window.innerWidth - 200);
              const y = Math.min(event.clientY, window.innerHeight - 140);
              setContextMenu({ x, y, row });
            },
          })}
          columns={[
            {
              title: '时间',
              dataIndex: 'startedAt',
              render: formatDateTime,
            },
            {
              title: '状态',
              dataIndex: 'outcome',
              render: (outcome: RequestOutcome, row) => {
                const view = OUTCOME_VIEW[outcome];
                return (
                  <Space size={4}>
                    <Tooltip title={view.hint}>
                      <Tag color={view.color}>{view.label}</Tag>
                    </Tooltip>
                    {row.httpStatus ? <span className="faint">{row.httpStatus}</span> : null}
                  </Space>
                );
              },
            },
            {
              title: '模型',
              render: (_: unknown, row) => (
                <Space size={4} direction="vertical">
                  <span>{row.requestedModel ?? '（未指定）'}</span>
                  {/* 真实模型与请求模型不同时才提示，避免重复信息 */}
                  {row.finalModel && row.finalModel !== row.requestedModel ? (
                    <span className="faint mono">→ {row.finalModel}</span>
                  ) : null}
                </Space>
              ),
            },
            {
              title: 'Provider',
              dataIndex: 'finalProviderName',
              render: (name: string | null, row) => (
                <Space size={4}>
                  <span>{name ?? '—'}</span>
                  {row.finalRole && row.finalRole !== 'primary' ? (
                    <Tag>{ROLE_LABEL[row.finalRole] ?? row.finalRole}</Tag>
                  ) : null}
                  {row.fallbackTriggered ? <Tag color="orange">触发保底</Tag> : null}
                </Space>
              ),
            },
            {
              title: '尝试',
              dataIndex: 'attemptCount',
              align: 'right',
            },
            {
              title: 'TTFB',
              dataIndex: 'ttfbMs',
              align: 'right',
              render: formatMs,
            },
            {
              title: '总耗时',
              dataIndex: 'totalMs',
              align: 'right',
              render: formatMs,
            },
            {
              title: 'Token',
              align: 'right',
              render: (_: unknown, row) => formatTokens(row.promptTokens + row.completionTokens),
            },
            {
              title: 'IP',
              dataIndex: 'ip',
              render: (ip: string | null) => <span className="mono">{ip ?? '—'}</span>,
            },
            {
              title: '流式',
              dataIndex: 'stream',
              render: (stream: boolean) => (stream ? <Tag>SSE</Tag> : null),
            },
          ]}
        />
      </Card>

      <Drawer
        width={620}
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title={detail.data ? `请求 #${detail.data.id}` : '请求详情'}
        destroyOnClose
      >
        {detail.status === 'error' ? (
          <Alert type="error" showIcon message="详情加载失败" description={detail.error} />
        ) : null}

        {detail.data ? (
          <div className="stack">
            <div className="detail-grid">
              <div>
                <span className="faint">Trace ID</span>
                <div className="mono">{detail.data.traceId}</div>
              </div>
              <div>
                <span className="faint">开始时间</span>
                <div>{formatDateTime(detail.data.startedAt)}</div>
              </div>
              <div>
                <span className="faint">首字节</span>
                <div>{formatMs(detail.data.ttfbMs)}</div>
              </div>
              <div>
                <span className="faint">总耗时</span>
                <div>{formatMs(detail.data.totalMs)}</div>
              </div>
              <div>
                <span className="faint">Prompt / Completion</span>
                <div>
                  {formatTokens(detail.data.promptTokens)} / {formatTokens(detail.data.completionTokens)}
                </div>
              </div>
              <div>
                <span className="faint">IP</span>
                {detail.data.ip ? (
                  <Typography.Text className="mono" copyable={{ text: detail.data.ip }}>
                    {detail.data.ip}
                  </Typography.Text>
                ) : (
                  <div>—</div>
                )}
              </div>
              <div>
                <span className="faint">错误码</span>
                <div>{detail.data.errorCode ?? '—'}</div>
              </div>
            </div>

            {detail.data.errorMessage ? (
              <Alert type="warning" showIcon message={detail.data.errorMessage} />
            ) : null}

            {detail.data.content ? (
              <Card size="small" title="请求与响应内容">
                <div className="content-log-stack">
                  <ContentLogSection title="客户端请求" value={detail.data.content.clientRequest} type="request" />
                  <ContentLogSection title="实际上游请求" value={detail.data.content.upstreamRequest} type="request" />
                  <ContentLogSection title="AI 响应" value={detail.data.content.aiResponse} type="response" />
                </div>
              </Card>
            ) : (
              <Alert type="info" showIcon message="此请求未记录正文" description="正文记录未启用，或该日志产生于功能启用之前。" />
            )}

            {/*
              尝试时间线：每一跳都在这里，包括旧实现只打 console.warn 就丢弃的
              中途重试失败，以及被并行 provider 抢占的那一跳。
            */}
            <Timeline
              items={detail.data.attempts.map((attempt) => ({
                color: STATUS_COLOR[attempt.status],
                children: (
                  <div className="attempt-item">
                    <Space wrap size={6}>
                      <strong>#{attempt.seq}</strong>
                      <Tag>{ROLE_LABEL[attempt.role] ?? attempt.role}</Tag>
                      <span>{attempt.providerName ?? '—'}</span>
                      <Tag color={STATUS_COLOR[attempt.status]}>{STATUS_LABEL[attempt.status]}</Tag>
                    </Space>

                    <div className="faint mono">
                      {attempt.attemptedModel ?? '—'}
                      {attempt.actualModel && attempt.actualModel !== attempt.attemptedModel
                        ? ` → ${attempt.actualModel}`
                        : ''}
                    </div>

                    <Space size={12} className="faint">
                      <span>{formatMs(attempt.durationMs)}</span>
                      {attempt.timeoutMs ? (
                        <Tooltip title="该次尝试使用的超时上限">
                          <span>超时 {formatMs(attempt.timeoutMs)}</span>
                        </Tooltip>
                      ) : null}
                    </Space>

                    {attempt.errorMessage ? (
                      <div className="attempt-error">{attempt.errorMessage}</div>
                    ) : null}
                  </div>
                ),
              }))}
            />
          </div>
        ) : null}
      </Drawer>

      {/* 快速封禁：确认 + 可选备注，直接复用黑名单 upsert 接口 */}
      <Modal
        title={`快速封禁 ${banTarget ?? ''}`}
        open={banTarget !== null}
        onCancel={() => setBanTarget(null)}
        footer={null}
        destroyOnClose
      >
        <Popconfirm
          title={`确认封禁 ${banTarget ?? ''}？`}
          description="封禁后该 IP 的所有请求都会被网关拒绝。"
          okText="确认封禁"
          okButtonProps={{ danger: true }}
          onConfirm={() => void quickBan()}
          disabled={banning}
        >
          <Button type="primary" danger loading={banning}>确认封禁</Button>
        </Popconfirm>
        <Input
          style={{ marginTop: 12 }}
          placeholder="备注（可选，最多 200 字符）"
          maxLength={200}
          value={banNote}
          onChange={(event) => setBanNote(event.target.value)}
          onPressEnter={() => void quickBan()}
        />
      </Modal>

      {/* 单 IP 详细统计：沿用日志页当前时间筛选 */}
      <Drawer
        width={520}
        open={statsIp !== null}
        onClose={() => setStatsIp(null)}
        title={statsIp ? `IP 统计：${statsIp}` : 'IP 统计'}
        destroyOnClose
      >
        {ipStats.status === 'error' ? (
          <Alert type="error" showIcon message="统计加载失败" description={ipStats.error} />
        ) : null}
        {ipStats.status === 'loading' ? <Alert type="info" showIcon message="加载中…" /> : null}
        {ipStats.data ? <IpStatsBody stats={ipStats.data} range={statsRange} /> : null}
      </Drawer>
    </div>
  );
}

function IpStatsBody({ stats, range }: { stats: IpDetailStatsDTO; range: { from?: string; to?: string } }) {
  const { breakdown } = stats;
  // outcome -> breakdown 字段名（DTO 用 snake_case，breakdown 用 camelCase）
  const BREAKDOWN_KEY: Record<RequestOutcome, keyof IpDetailStatsDTO['breakdown']> = {
    upstream_ok: 'upstreamOk',
    cache_hit: 'cacheHit',
    upstream_error: 'upstreamError',
    client_abort: 'clientAbort',
    rejected: 'rejected',
  };
  return (
    <div className="stack">
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="请求总数">{formatCount(stats.requests)}</Descriptions.Item>
        <Descriptions.Item label="总 Token">{formatTokens(stats.totalTokens)}</Descriptions.Item>
        <Descriptions.Item label="交付率">{formatPercent(stats.serviceSuccessRate)}</Descriptions.Item>
        <Descriptions.Item label="上游成功率">{formatPercent(stats.upstreamSuccessRate)}</Descriptions.Item>
        <Descriptions.Item label="平均首字节">{formatMs(stats.avgTtfbMs)}</Descriptions.Item>
        <Descriptions.Item label="平均总耗时">{formatMs(stats.avgTotalMs)}</Descriptions.Item>
        <Descriptions.Item label="首次活跃">{stats.firstSeenAt ? formatDateTime(stats.firstSeenAt) : '—'}</Descriptions.Item>
        <Descriptions.Item label="最近活跃">{stats.lastSeenAt ? formatDateTime(stats.lastSeenAt) : '—'}</Descriptions.Item>
      </Descriptions>

      <Card size="small" title="结局分布">
        <Space direction="vertical" style={{ width: '100%' }} size={6}>
          {(Object.keys(OUTCOME_VIEW) as RequestOutcome[]).map((outcome) => (
            <div key={outcome} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Tooltip title={OUTCOME_VIEW[outcome].hint}>
                <Tag color={OUTCOME_VIEW[outcome].color}>{OUTCOME_VIEW[outcome].label}</Tag>
              </Tooltip>
              <span className="mono">{formatCount(breakdown[BREAKDOWN_KEY[outcome]])}</span>
            </div>
          ))}
        </Space>
      </Card>

      <Card size="small" title="模型分布（Top 10）">
        {stats.models.length === 0 ? (
          <span className="faint">范围内没有请求</span>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            {stats.models.map((model) => (
              <div key={model.model} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="mono">{model.model}</span>
                <span className="mono">{formatCount(model.requests)}</span>
              </div>
            ))}
          </Space>
        )}
      </Card>

      <div className="faint">
        统计区间：
        {range.from ? ` ${range.from} 起` : ' 全部历史'}
        {range.to ? ` 至 ${range.to}` : ''}
        ；与日志页筛选一致。
        <Link to="/admin/ips" style={{ marginLeft: 8 }}>在 IP 统计页查看 →</Link>
      </div>
    </div>
  );
}