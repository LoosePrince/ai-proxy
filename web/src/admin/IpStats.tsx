/**
 * IP 统计。
 *
 * 数据来自 ip_usage_daily 与 ips 维度表。旧实现把所有 IP 塞进
 * 一条虚拟 provider 行的 stats.ips JSON 里，IP 数量增长后这个 JSON
 * 会无限膨胀，且每次请求都要整块读改写。现在是按 (ip_id, day) 原子累加的行。
 *
 * 「首次出现 / 最近出现」来自 ips 表本身，因此即使明细被保留策略清掉，
 * 一个 IP 的活跃区间仍然可查。
 */

import { Alert, Button, Card, Input, Space, Table } from 'antd';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { adminApi } from '../api/client';
import { DayRangePicker, useDayRange } from '../components/DayRangePicker';
import { useAsync } from '../hooks/useAsync';
import { formatCount, formatDateTime, formatTokens } from '../lib/format';
import type { IpUsageDTO } from '@shared/api';

export function IpStats() {
  const { range, control } = useDayRange();
  const usage = useAsync(() => adminApi.ipUsage(range), [range.from, range.to]);
  const [keyword, setKeyword] = useState('');

  // IP 列表通常不长（后端 limit 200），本地过滤即可，无需再打一次请求
  const rows = useMemo(() => {
    const list = usage.data ?? [];
    const text = keyword.trim();
    return text ? list.filter((item) => item.ip.includes(text)) : list;
  }, [usage.data, keyword]);

  return (
    <div className="stack">
      {usage.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="IP 统计加载失败"
          description={usage.error}
          action={<Button onClick={usage.reload}>重试</Button>}
        />
      ) : null}

      <Card
        title="IP 用量"
        extra={
          <Space wrap>
            <Input.Search
              size="small"
              allowClear
              placeholder="筛选 IP"
              className="control-w-180"
              onChange={(event) => setKeyword(event.target.value)}
            />
            <DayRangePicker {...control} />
            <Button size="small" onClick={usage.reload}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<IpUsageDTO>
          rowKey="ip"
          dataSource={rows}
          loading={usage.status === 'loading'}
          size="small"
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: 'IP',
              dataIndex: 'ip',
              render: (ip: string) => <span className="mono">{ip}</span>,
            },
            {
              title: '请求次数',
              dataIndex: 'requests',
              align: 'right',
              defaultSortOrder: 'descend',
              sorter: (a, b) => a.requests - b.requests,
              render: formatCount,
            },
            {
              title: 'Token',
              dataIndex: 'tokens',
              align: 'right',
              sorter: (a, b) => a.tokens - b.tokens,
              render: formatTokens,
            },
            {
              title: '首次出现',
              dataIndex: 'firstSeenAt',
              render: formatDateTime,
            },
            {
              title: '最近出现',
              dataIndex: 'lastSeenAt',
              render: formatDateTime,
            },
            {
              title: '',
              align: 'right',
              // 直接跳到日志页并带上 ip 过滤，省掉手工复制粘贴
              render: (_: unknown, row) => (
                <Link to={`/admin/logs?ip=${encodeURIComponent(row.ip)}`}>查看请求</Link>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}