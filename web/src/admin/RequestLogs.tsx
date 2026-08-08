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

import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Drawer, Input, Select, Space, Table, Tag, Timeline, Tooltip } from 'antd';

import { adminApi } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime, formatMs, formatTokens } from '../lib/format';
import type { AttemptStatus, RequestListQuery, RequestSummaryDTO } from '@shared/api';

const PAGE_SIZE = 20;

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

export function RequestLogs() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<number | null>(null);

  // URL 是筛选条件的唯一来源，组件不另存一份 state，避免两者不同步
  const query = useMemo<RequestListQuery>(() => {
    const success = params.get('success');
    const result: RequestListQuery = {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    if (success === 'true') result.success = true;
    if (success === 'false') result.success = false;
    const model = params.get('requestedModel');
    if (model) result.requestedModel = model;
    const ip = params.get('ip');
    if (ip) result.ip = ip;
    return result;
  }, [params, page]);

  const list = useAsync(
    () => adminApi.requests(query),
    [query.limit, query.offset, query.success, query.requestedModel, query.ip],
  );

  const detail = useAsync(
    () => (detailId === null ? Promise.resolve(null) : adminApi.requestDetail(detailId)),
    [detailId],
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

  return (
    <div className="stack">
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
            <Select
              size="small"
              className="control-w-110"
              value={params.get('success') ?? 'all'}
              onChange={(value) => patchFilter('success', value === 'all' ? null : value)}
              options={[
                { label: '全部状态', value: 'all' },
                { label: '仅成功', value: 'true' },
                { label: '仅失败', value: 'false' },
              ]}
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
          onRow={(row) => ({ onClick: () => setDetailId(row.id) })}
          columns={[
            {
              title: '时间',
              dataIndex: 'startedAt',
              render: formatDateTime,
            },
            {
              title: '状态',
              dataIndex: 'success',
              render: (success: boolean, row) => (
                <Space size={4}>
                  <Tag color={success ? 'green' : 'red'}>{success ? '成功' : '失败'}</Tag>
                  {row.httpStatus ? <span className="faint">{row.httpStatus}</span> : null}
                </Space>
              ),
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
                <span className="faint">错误码</span>
                <div>{detail.data.errorCode ?? '—'}</div>
              </div>
            </div>

            {detail.data.errorMessage ? (
              <Alert type="warning" showIcon message={detail.data.errorMessage} />
            ) : null}

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
    </div>
  );
}