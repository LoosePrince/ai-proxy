/**
 * 全局设置。
 *
 * 对应后端两个独立资源，页面上分成两块，因为它们的生命周期不同：
 *   settings         全站唯一一份 key-value 配置
 *   priority_groups  每个优先级组一行，随 Provider 的 priority 分布变化
 *
 * 旧实现把这些全塞在一条负 priority 虚拟行的 stats.modelConfig JSON 里，
 * 保存时整块读改写，两个人同时改配置后写会覆盖前写。现在每项都是独立行，
 * 且只提交实际改动的字段，互不干扰。
 *
 * 保底 / 并行 Provider 不在这里配置：它们已经是 providers 表里 kind 标记的
 * 真实行，统一在 Provider 页管理，避免同一个实体有两个编辑入口。
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { Link } from 'react-router-dom';

import { adminApi } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import type {
  MaliciousBehaviorAction,
  PriorityGroupDTO,
  RequestBehaviorAction,
  RoutingRule,
  SettingsDTO,
} from '@shared/api';

const RULE_OPTIONS: Array<{ label: string; value: RoutingRule }> = [
  { label: 'priority（按顺序）', value: 'priority' },
  { label: 'random（随机）', value: 'random' },
  { label: 'average（轮转）', value: 'average' },
];

const IDE_ACTION_OPTIONS: Array<{ label: string; value: RequestBehaviorAction }> = [
  { label: '忽略请求（200 + 空消息）', value: 'ignore' },
  { label: '失败（返回错误码）', value: 'error' },
  { label: '去除用户提供的系统提示词后继续', value: 'strip-system-prompt' },
];

const MALICIOUS_ACTION_OPTIONS: Array<{ label: string; value: MaliciousBehaviorAction }> = [
  { label: '忽略请求（200 + 空消息）', value: 'ignore' },
  { label: '失败（返回错误码）', value: 'error' },
  { label: '返回指定响应内容', value: 'response' },
];

function SettingsForm({ initial, onSaved }: { initial: SettingsDTO; onSaved: () => void }) {
  const [form] = Form.useForm<SettingsDTO>();
  const [saving, setSaving] = useState(false);

  // 数据重新拉取后同步进表单，避免用户看到的是上一次的旧值
  useEffect(() => {
    form.setFieldsValue(initial);
  }, [form, initial]);

  const submit = async (values: SettingsDTO) => {
    setSaving(true);
    try {
      await adminApi.saveSettings(values);
      message.success('设置已保存');
      onSaved();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form form={form} layout="vertical" initialValues={initial} onFinish={submit}>
      <div className="settings-grid">
        <Form.Item
          name="globalRule"
          label="全局路由规则"
          tooltip="决定优先级组之间的尝试顺序。组内顺序由下方各组自己的规则决定。"
        >
          <Select options={RULE_OPTIONS} />
        </Form.Item>

        <Form.Item
          name="defaultResponseTimeoutMs"
          label="主路由默认超时（ms）"
          rules={[{ required: true, message: '必填' }]}
          tooltip="未单独设置超时的优先级组使用此值。"
        >
          <InputNumber min={1000} step={1000} className="control-full" />
        </Form.Item>

        <Form.Item
          name="fallbackResponseTimeoutMs"
          label="保底超时（ms）"
          rules={[{ required: true, message: '必填' }]}
          tooltip="主链全部失败后，保底 Provider 的单次调用超时。"
        >
          <InputNumber min={1000} step={1000} className="control-full" />
        </Form.Item>

        <Form.Item
          name="parallelTimeoutMs"
          label="并行竞速窗口（ms）"
          rules={[{ required: true, message: '必填' }]}
          tooltip="并行 Provider 只在此窗口内有权抢占响应；超窗后即使先返回也不再抢占，避免慢速旁路拖累整体延迟。"
        >
          <InputNumber min={1000} step={1000} className="control-full" />
        </Form.Item>

        <Form.Item
          name="maxPrimaryAttempts"
          label="主链最大尝试 Provider 数"
          rules={[{ required: true, message: '必填' }]}
          tooltip="尝试链会被截断到这个长度，防止 Provider 很多时单个请求耗时失控。"
        >
          <InputNumber min={1} max={20} className="control-full" />
        </Form.Item>

        <Form.Item
          name="maxModelRetryCount"
          label="单 Provider 模型重试上限"
          rules={[{ required: true, message: '必填' }]}
          tooltip="同一个 Provider 内最多尝试几个模型。"
        >
          <InputNumber min={1} max={20} className="control-full" />
        </Form.Item>

        <Form.Item
          name="ipRateLimitRpm"
          label="同 IP 每分钟请求上限"
          rules={[{ required: true, message: '必填' }]}
          tooltip="0 表示不限流。限流是进程内的滑动窗口，多实例部署时每个实例独立计数。"
        >
          <InputNumber min={0} className="control-full" />
        </Form.Item>

        <Form.Item
          name="logRetentionDays"
          label="日志保留天数"
          rules={[{ required: true, message: '必填' }]}
          tooltip="0 表示永不清理。清理只删请求明细，日聚合统计永久保留，因此面板上的历史趋势不会因清理而回退。"
        >
          <InputNumber min={0} className="control-full" />
        </Form.Item>

        <Form.Item
          name="requestContentLoggingEnabled"
          label="启用请求内容记录"
          valuePropName="checked"
          tooltip="保存客户端请求、实际发给上游的请求和 AI 响应正文。关闭后新日志不再保存正文，已有正文不受影响。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="publicRequestContentStreamEnabled"
          label="启用公开请求内容流"
          valuePropName="checked"
          tooltip="开放 /api/request-content-stream。仅发布内存中的脱敏内容，不会因为开启此项而保存原始正文。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="requestCacheEnabled"
          label="启用请求缓存"
          valuePropName="checked"
          tooltip="相同协议、请求参数和流式形态的成功响应会持久化复用。缓存记录默认不自动清理。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="requestCacheReuseHours"
          label="请求缓存复用间隔（小时）"
          rules={[{ required: true, message: '必填' }]}
          tooltip="默认只命中 24 小时内生成的缓存。超过窗口的记录继续保留，但不会被复用。"
        >
          <InputNumber min={1} max={8760} className="control-full" />
        </Form.Item>
      </div>

      <Card size="small" title="全局系统提示词" className="nested-settings-card">
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          该内容会以服务端强制规则的形式注入到每个 Provider 上游请求的第一条消息，优先于客户端消息。
        </Typography.Paragraph>
        <Form.Item
          name="globalSystemPrompt"
          label="内置系统提示词"
          extra="留空表示不注入全局提示词。请只填写稳定、可长期适用的规则。"
        >
          <Input.TextArea autoSize={{ minRows: 5, maxRows: 14 }} placeholder="例如：始终使用简体中文回答，并遵守以下业务规则……" />
        </Form.Item>
      </Card>

      <Card size="small" title="特定 AI 行为处理" className="nested-settings-card">
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          代理会在限流、缓存和上游调用前检查请求。检测规则是服务端启发式规则，误判时可调整处理方式。
        </Typography.Paragraph>
        <div className="settings-grid">
          <Form.Item
            name="ideRequestAction"
            label="检测到 IDE 环境或工具链请求"
            tooltip="检查 system/developer 消息、工具定义和常见 IDE 工具名称。"
          >
            <Select options={IDE_ACTION_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="maliciousRequestAction"
            label="检测到恶意行为内容"
            tooltip="覆盖逆序、越狱、破解、攻击和明显违法内容等模式。"
          >
            <Select options={MALICIOUS_ACTION_OPTIONS} />
          </Form.Item>
        </div>
        <Form.Item
          name="maliciousResponse"
          label="恶意内容指定响应"
          extra="仅当上方选择“返回指定响应内容”时生效。"
        >
          <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder="请输入要返回给客户端的内容" />
        </Form.Item>
      </Card>

      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>
          保存设置
        </Button>
        <Button onClick={() => form.setFieldsValue(initial)} disabled={saving}>
          放弃修改
        </Button>
      </Space>
    </Form>
  );
}

function PriorityGroups() {
  const groups = useAsync(() => adminApi.priorityGroups(), []);
  const [busy, setBusy] = useState<number | null>(null);

  const save = async (priority: number, patch: { rule?: RoutingRule; timeoutMs?: number | null }) => {
    setBusy(priority);
    try {
      await adminApi.savePriorityGroup(priority, patch);
      message.success(`优先级 ${priority} 已更新`);
      groups.reload();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="优先级组"
      extra={
        <Button size="small" onClick={groups.reload}>
          刷新
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" className="paragraph-flush">
        组是真实实体：规则与超时是组自身的属性。旧实现「组内规则取该组第一个 Provider 的
        rule」，导致删掉一个 Provider 就可能悄悄改变整组的路由行为。组由{' '}
        <Link to="/admin/providers">Provider</Link> 的 priority 自动产生，空组会被清理。
      </Typography.Paragraph>

      <Table<PriorityGroupDTO>
        rowKey="priority"
        size="small"
        pagination={false}
        loading={groups.status === 'loading'}
        dataSource={groups.data ?? []}
        columns={[
          { title: '优先级', dataIndex: 'priority', width: 90 },
          { title: 'Provider 数', dataIndex: 'providerCount', width: 110, align: 'right' },
          {
            title: '组内规则',
            width: 200,
            render: (_: unknown, row) => (
              <Select
                size="small"
                className="control-full"
                value={row.rule}
                options={RULE_OPTIONS}
                disabled={busy === row.priority}
                onChange={(rule) => void save(row.priority, { rule })}
              />
            ),
          },
          {
            title: '组超时（ms）',
            width: 200,
            render: (_: unknown, row) => (
              <Tooltip title="留空表示继承全局默认超时">
                <InputNumber
                  size="small"
                  min={1000}
                  step={1000}
                  className="control-full"
                  placeholder="继承全局"
                  defaultValue={row.timeoutMs ?? undefined}
                  disabled={busy === row.priority}
                  // 失焦时提交：避免每敲一个数字就打一次请求
                  onBlur={(event) => {
                    const raw = event.target.value.trim();
                    const next = raw === '' ? null : Number(raw);
                    if (next === (row.timeoutMs ?? null)) return;
                    void save(row.priority, { timeoutMs: next });
                  }}
                />
              </Tooltip>
            ),
          },
        ]}
      />
    </Card>
  );
}

export function SettingsPage() {
  const settings = useAsync(() => adminApi.settings(), []);

  return (
    <div className="stack">
      {settings.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="设置加载失败"
          description={settings.error}
          action={<Button onClick={settings.reload}>重试</Button>}
        />
      ) : null}

      <Card title="全局设置" loading={settings.status === 'loading'}>
        {settings.data ? (
          <SettingsForm initial={settings.data} onSaved={settings.reload} />
        ) : null}
      </Card>

      <PriorityGroups />

      <RuntimePanel />
    </div>
  );
}

/**
 * 运行时观测。
 *
 * 这些数字是判断「内存结构有没有异常增长」的唯一手段：旧实现有两处无上界的
 * Map（RR 计数器与上游客户端缓存）持续泄漏，但当时没有任何可观测入口。
 */
function RuntimePanel() {
  const runtime = useAsync(() => adminApi.runtime(), []);
  const [sweeping, setSweeping] = useState(false);

  useEffect(() => {
    const timer = setInterval(runtime.reload, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sweep = async () => {
    setSweeping(true);
    try {
      const result = await adminApi.sweepRetention();
      message.success(
        result.deleted > 0 ? `已清理 ${result.deleted} 条请求明细` : '没有需要清理的记录',
      );
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSweeping(false);
    }
  };

  const data = runtime.data;

  return (
    <Card
      title="运行时状态"
      extra={
        <Space>
          <Tooltip title="按当前保留天数立即执行一次清理，不必等 6 小时的后台周期">
            <Button size="small" loading={sweeping} onClick={() => void sweep()}>
              立即清理日志
            </Button>
          </Tooltip>
          <Button size="small" onClick={runtime.reload}>
            刷新
          </Button>
        </Space>
      }
    >
      {data ? (
        <div className="runtime-grid">
          <div>
            <div className="stat-label">配置快照</div>
            <div className="stat-value">{data.config.cached ? '已缓存' : '未缓存'}</div>
            <div className="stat-hint">
              {data.config.providerCount} 个 Provider · {data.config.groupCount} 个组
            </div>
          </div>
          <div>
            <div className="stat-label">写队列积压</div>
            <div className="stat-value">{data.writeQueue.pending}</div>
            <div className="stat-hint">
              已落盘 {data.writeQueue.persisted} · 丢弃 {data.writeQueue.dropped}
            </div>
          </div>
          <div>
            <div className="stat-label">限流桶 / 轮转游标</div>
            <div className="stat-value">
              {data.counters.ipBuckets} / {data.counters.rotationCursors}
            </div>
            <div className="stat-hint">均有上界，超出后按最久未用淘汰</div>
          </div>
          <div>
            <div className="stat-label">上游客户端缓存</div>
            <div className="stat-value">{data.upstreamClients}</div>
            <div className="stat-hint">LRU，容量 64</div>
          </div>
        </div>
      ) : null}

      {data?.writeQueue.lastError ? (
        <Alert
          className="mt-12"
          type="warning"
          showIcon
          message="写队列上次落盘失败"
          description={data.writeQueue.lastError}
        />
      ) : null}
    </Card>
  );
}