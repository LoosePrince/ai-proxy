/**
 * 模型统计。
 *
 * 数据来自 model_usage_daily 的 (requested_model, actual_model, day) 聚合。
 * 展开行显示「请求模型 -> 上游真实模型」的分布 —— 这正是旧实现塞在
 * stats.models[x].actualResolved 嵌套 JSON 里的信息，现在是可查询的表。
 *
 * 这个分布很有诊断价值：请求 gpt-4 实际落到别的模型上，说明某个 provider
 * 声明了它并不真正提供的模型。
 */

import { Alert, Button, Card, Space, Table, Tag } from 'antd';

import { adminApi } from '../api/client';
import { DayRangePicker, useDayRange } from '../components/DayRangePicker';
import { useAsync } from '../hooks/useAsync';
import { formatCount, formatTokens } from '../lib/format';
import type { ModelUsageDTO } from '@shared/api';

export function ModelStats() {
  const { range, control } = useDayRange();
  const usage = useAsync(() => adminApi.modelUsage(range), [range.from, range.to]);

  return (
    <div className="stack">
      {usage.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="模型统计加载失败"
          description={usage.error}
          action={<Button onClick={usage.reload}>重试</Button>}
        />
      ) : null}

      <Card
        title="模型用量"
        extra={
          <Space>
            <DayRangePicker {...control} />
            <Button size="small" onClick={usage.reload}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<ModelUsageDTO>
          rowKey="requestedModel"
          dataSource={usage.data ?? []}
          loading={usage.status === 'loading'}
          size="small"
          scroll={{ x: 'max-content' }}
          expandable={{
            // 只有存在多个真实模型或真实模型与请求模型不一致时才值得展开
            rowExpandable: (row) => row.actualResolved.length > 0,
            expandedRowRender: (row) => (
              <div className="resolved-list">
                {row.actualResolved
                  .slice()
                  .sort((a, b) => b.requests - a.requests)
                  .map((item) => (
                    <div key={item.model} className="resolved-item">
                      <Tag color={item.model === row.requestedModel ? 'green' : 'orange'}>
                        {item.model}
                      </Tag>
                      <span className="muted">{formatCount(item.requests)} 次</span>
                    </div>
                  ))}
              </div>
            ),
          }}
          columns={[
            { title: '请求模型', dataIndex: 'requestedModel' },
            {
              title: '模型数',
              align: 'right',
              render: (_: unknown, row) => row.actualResolved.length,
            },
            { title: '请求次数', dataIndex: 'requests', align: 'right', render: formatCount },
            { title: 'Prompt', dataIndex: 'promptTokens', align: 'right', render: formatTokens },
            {
              title: 'Completion',
              dataIndex: 'completionTokens',
              align: 'right',
              render: formatTokens,
            },
            {
              title: 'Token 合计',
              align: 'right',
              render: (_: unknown, row) => formatTokens(row.promptTokens + row.completionTokens),
            },
          ]}
        />
      </Card>
    </div>
  );
}