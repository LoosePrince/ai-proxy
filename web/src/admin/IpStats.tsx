/**
 * IP 统计。
 *
 * 数据来自 ip_usage_daily 与 ips 维度表。旧实现把所有 IP 塞进
 * 一条虚拟 provider 行的 stats.ips JSON 里，IP 数量增长后这个 JSON
 * 会无限膨胀，且每次请求都要整块读改写。现在是按 (ip_id, day) 原子累加的行。
 *
 * 「范围内首次活跃 / 最近活跃」来自日聚合表，因此会随日期筛选同步变化，
 * 不会把该 IP 的全生命周期时间误显示成当前筛选区间的结果。
 */

import { useMemo, useState } from 'react';
import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Space, Table, message } from 'antd';
import { Link } from 'react-router-dom';

import { adminApi } from '../api/client';
import { DayRangePicker, useDayRange } from '../components/DayRangePicker';
import { useAsync } from '../hooks/useAsync';
import { formatCount, formatDateTime, formatTokens } from '../lib/format';
import type { IpBlacklistDTO, IpUsageDTO } from '@shared/api';

function IpBlacklistPanel() {
  const blacklist = useAsync(() => adminApi.ipBlacklist(), []);
  const [form] = Form.useForm<{ ip: string; note?: string }>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const add = async (values: { ip: string; note?: string }) => {
    setSaving(true);
    try {
      await adminApi.addIpBlacklist(values.ip.trim(), values.note?.trim() || null);
      form.resetFields();
      setOpen(false);
      message.success('IP 已加入黑名单');
      blacklist.reload();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ip: string) => {
    try {
      await adminApi.removeIpBlacklist(ip);
      message.success('IP 已移出黑名单');
      blacklist.reload();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  return (
    <Card
      title="IP 黑名单"
      extra={
        <Space>
          <Button size="small" onClick={blacklist.reload}>刷新</Button>
          <Button size="small" type="primary" onClick={() => setOpen(true)}>添加 IP</Button>
        </Space>
      }
    >
      <Table<IpBlacklistDTO>
        rowKey="ip"
        dataSource={blacklist.data ?? []}
        loading={blacklist.status === 'loading'}
        size="small"
        pagination={false}
        locale={{ emptyText: '暂无黑名单 IP' }}
        columns={[
          { title: 'IP', dataIndex: 'ip', render: (ip: string) => <span className="mono">{ip}</span> },
          { title: '备注', dataIndex: 'note', render: (note: string | null) => note || '—' },
          { title: '添加时间', dataIndex: 'createdAt', render: formatDateTime },
          {
            title: '',
            align: 'right',
            render: (_: unknown, row) => (
              <Popconfirm title={`确认解除 ${row.ip} 的封禁？`} onConfirm={() => void remove(row.ip)}>
                <Button size="small" danger>解除封禁</Button>
              </Popconfirm>
            ),
          },
        ]}
      />

      <Modal title="添加 IP 黑名单" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={add}>
          <Form.Item
            name="ip"
            label="IP 地址"
            rules={[{ required: true, message: '请填写 IP 地址' }]}
          >
            <Input placeholder="例如 203.0.113.10 或 2001:db8::1" autoComplete="off" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={200} placeholder="可选，最多 200 个字符" />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>确认封禁</Button>
            <Button onClick={() => setOpen(false)} disabled={saving}>取消</Button>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}

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
      <IpBlacklistPanel />

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
              title: '范围内首次活跃',
              dataIndex: 'firstSeenAt',
              render: formatDateTime,
            },
            {
              title: '范围内最近活跃',
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