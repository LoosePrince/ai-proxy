/**
 * Provider 管理。
 *
 * 相对旧后台的三个语义修正：
 *
 *   1. apiKey 不再回显脱敏串。旧实现返回 `sk-1***abcd`，再靠「字符串是否含 ***」
 *      判断用户有没有改动 —— 真实 key 含 *** 就会被误判为未改动而丢弃。
 *      现在只显示是否已配置，输入框留空即表示保持不变。
 *
 *   2. 保底与并行 Provider 是 kind 字段标记的真实行，不再是 id -10001 的伪对象，
 *      因此和普通 Provider 用同一套 CRUD，无需单独的配置表单。
 *
 *   3. 组内路由规则属于 priority 组，不再逐行冗余存储。改组规则是改一个组实体，
 *      而不是把同一个值写进组内每一行。
 */

import { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';

import { adminApi } from '../api/client';
import { ModelChipEditor } from '../components/ModelChipEditor';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../lib/format';
import type { PriorityGroupDTO, ProviderDTO, ProviderKind, RoutingRule } from '@shared/api';

const KIND_LABEL: Record<ProviderKind, string> = {
  primary: '主路由',
  fallback: '保底',
  parallel: '并行',
};

const KIND_COLOR: Record<ProviderKind, string> = {
  primary: 'blue',
  fallback: 'volcano',
  parallel: 'purple',
};

const SOURCE_LABEL: Record<string, string> = {
  managed: '后台创建',
  env: '环境变量',
  contributed: '社区贡献',
};

const RULE_LABEL: Record<RoutingRule, string> = {
  priority: '按顺序',
  random: '随机',
  average: '轮转',
};

interface FormValues {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  systemPrompt: string;
  kind: ProviderKind;
  priority: number;
  enabled: boolean;
}

export function Providers() {
  const providers = useAsync(() => adminApi.providers(), []);
  const groups = useAsync(() => adminApi.priorityGroups(), []);

  const [editing, setEditing] = useState<ProviderDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<FormValues>();
  const modelValues = Form.useWatch('models', form) ?? [];

  const reloadAll = useCallback(() => {
    providers.reload();
    groups.reload();
  }, [providers, groups]);

  const openCreate = useCallback(() => {
    form.setFieldsValue({
      name: '',
      baseUrl: '',
      apiKey: '',
      models: [],
      systemPrompt: '',
      kind: 'primary',
      priority: 0,
      enabled: true,
    });
    setEditing(null);
    setCreating(true);
  }, [form]);

  const openEdit = useCallback(
    (record: ProviderDTO) => {
      form.setFieldsValue({
        name: record.name,
        baseUrl: record.baseUrl,
        // 留空表示保持原 key，不预填任何占位字符
        apiKey: '',
        models: record.models,
        systemPrompt: record.systemPrompt,
        kind: record.kind,
        priority: record.priority,
        enabled: record.enabled,
      });
      setEditing(record);
      setCreating(false);
    },
    [form],
  );

  const closeModal = useCallback(() => {
    setEditing(null);
    setCreating(false);
  }, []);

  const submit = useCallback(async () => {
    const values = await form.validateFields();
    setSaving(true);

    try {
      if (editing) {
        // apiKey 为空时不放进 patch，后端据此保持原值
        const patch = { ...values, apiKey: values.apiKey?.trim() || undefined };
        await adminApi.updateProvider(editing.id, patch);
        message.success('Provider 已更新');
      } else {
        await adminApi.createProvider({ ...values, apiKey: values.apiKey?.trim() ?? '' });
        message.success('Provider 已创建');
      }

      closeModal();
      reloadAll();
    } catch (error) {
      message.error((error as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [closeModal, editing, form, reloadAll]);

  /** 启停是高频操作，直接在列表里切换，不必进编辑弹窗 */
  const toggleEnabled = useCallback(
    async (record: ProviderDTO, enabled: boolean) => {
      try {
        await adminApi.updateProvider(record.id, { enabled });
        reloadAll();
      } catch (error) {
        message.error((error as Error).message || '状态切换失败');
      }
    },
    [reloadAll],
  );

  const remove = useCallback(
    async (record: ProviderDTO) => {
      try {
        await adminApi.deleteProvider(record.id);
        message.success(`已删除 ${record.name}`);
        reloadAll();
      } catch (error) {
        message.error((error as Error).message || '删除失败');
      }
    },
    [reloadAll],
  );

  const saveGroup = useCallback(
    async (priority: number, patch: { rule?: RoutingRule; timeoutMs?: number | null }) => {
      try {
        await adminApi.savePriorityGroup(priority, patch);
        groups.reload();
        // 组规则影响路由顺序，快照失效由后端处理，这里只需重读
        providers.reload();
      } catch (error) {
        message.error((error as Error).message || '组配置保存失败');
      }
    },
    [groups, providers],
  );

  return (
    <div className="stack">
      {providers.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="Provider 列表加载失败"
          description={providers.error}
          action={<Button onClick={providers.reload}>重试</Button>}
        />
      ) : null}

      <Card
        title="Provider"
        extra={
          <Space>
            <Button size="small" onClick={reloadAll}>
              刷新
            </Button>
            <Button size="small" type="primary" onClick={openCreate}>
              新增 Provider
            </Button>
          </Space>
        }
      >
        <Table<ProviderDTO>
          rowKey="id"
          dataSource={providers.data ?? []}
          loading={providers.status === 'loading'}
          size="small"
          scroll={{ x: 'max-content' }}
          pagination={false}
          columns={[
            {
              title: '名称',
              render: (_: unknown, row) => (
                <Space direction="vertical" size={0}>
                  <span>{row.displayName}</span>
                  {row.displayName === row.name ? null : (
                    <span className="mono faint">{row.name}</span>
                  )}
                </Space>
              ),
            },
            {
              title: '角色',
              dataIndex: 'kind',
              render: (kind: ProviderKind) => <Tag color={KIND_COLOR[kind]}>{KIND_LABEL[kind]}</Tag>,
            },
            {
              title: '来源',
              dataIndex: 'source',
              render: (source: string) => <Tag>{SOURCE_LABEL[source] ?? source}</Tag>,
            },
            {
              title: 'Base URL',
              dataIndex: 'baseUrl',
              render: (url: string) => <span className="mono">{url}</span>,
            },
            {
              title: 'API Key',
              dataIndex: 'hasApiKey',
              render: (has: boolean) =>
                has ? <Tag color="green">已配置</Tag> : <Tag color="red">未配置</Tag>,
            },
            {
              title: '模型',
              dataIndex: 'models',
              render: (models: string[]) =>
                models.length === 0 ? (
                  <span className="faint">透传请求模型</span>
                ) : (
                  <Tooltip title={models.join('、')}>
                    <Tag>{models.length} 个</Tag>
                  </Tooltip>
                ),
            },
            {
              title: 'Priority',
              dataIndex: 'priority',
              align: 'right',
              // 特殊角色不参与 priority 分组，显示数字会造成误解
              render: (priority: number, row) =>
                row.kind === 'primary' ? priority : <span className="faint">—</span>,
            },
            {
              title: '组内规则',
              dataIndex: 'effectiveRule',
              render: (rule: RoutingRule, row) =>
                row.kind === 'primary' ? (
                  <span className="muted">{RULE_LABEL[rule]}</span>
                ) : (
                  <span className="faint">—</span>
                ),
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              render: (enabled: boolean, row) => (
                <Switch
                  size="small"
                  checked={enabled}
                  onChange={(next) => void toggleEnabled(row, next)}
                />
              ),
            },
            {
              title: '更新时间',
              dataIndex: 'updatedAt',
              render: (value: string) => <span className="faint">{formatDateTime(value)}</span>,
            },
            {
              title: '操作',
              render: (_: unknown, row) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  {row.source === 'env' ? (
                    <Tooltip title="环境变量来源的 Provider 需从 FALLBACK_PROVIDERS 移除">
                      <Button size="small" type="link" disabled>
                        删除
                      </Button>
                    </Tooltip>
                  ) : (
                    <Popconfirm
                      title={`删除 ${row.name}？`}
                      description="历史用量会保留，不影响统计追溯。"
                      onConfirm={() => void remove(row)}
                    >
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title="优先级组" extra={<span className="faint">组是实体，规则与超时按组配置</span>}>
        <Table<PriorityGroupDTO>
          rowKey="priority"
          dataSource={groups.data ?? []}
          loading={groups.status === 'loading'}
          size="small"
          pagination={false}
          columns={[
            { title: 'Priority', dataIndex: 'priority', align: 'right' },
            { title: 'Provider 数', dataIndex: 'providerCount', align: 'right' },
            {
              title: '组内规则',
              render: (_: unknown, row) => (
                <Select<RoutingRule>
                  size="small"
                  className="control-w-120"
                  value={row.rule}
                  onChange={(rule) => void saveGroup(row.priority, { rule })}
                  options={(Object.keys(RULE_LABEL) as RoutingRule[]).map((rule) => ({
                    value: rule,
                    label: RULE_LABEL[rule],
                  }))}
                />
              ),
            },
            {
              title: '组超时 (ms)',
              render: (_: unknown, row) => (
                <InputNumber
                  size="small"
                  min={1}
                  step={1000}
                  placeholder="继承全局"
                  value={row.timeoutMs}
                  onBlur={(event) => {
                    const raw = (event.target as HTMLInputElement).value.trim();
                    const next = raw === '' ? null : Number(raw);
                    if (next === row.timeoutMs) return;
                    void saveGroup(row.priority, { timeoutMs: next });
                  }}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={creating || !!editing}
        title={editing ? `编辑 ${editing.name}` : '新增 Provider'}
        onCancel={closeModal}
        onOk={() => void submit()}
        confirmLoading={saving}
        destroyOnClose
        maskClosable={false}
      >
        <Form<FormValues> form={form} layout="vertical" requiredMark="optional">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请填写名称' }]}
            extra={editing?.source === 'env' ? '环境变量来源的 Provider 不可改名' : undefined}
          >
            <Input disabled={editing?.source === 'env'} placeholder="provider-a" />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[
              { required: true, message: '请填写 Base URL' },
              { pattern: /^https?:\/\//i, message: '必须以 http:// 或 https:// 开头' },
            ]}
          >
            <Input disabled={editing?.source === 'env'} placeholder="https://api.example.com/v1" />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key"
            rules={editing ? [] : [{ required: true, message: '请填写 API Key' }]}
            extra={
              editing
                ? editing.hasApiKey
                  ? '留空表示保持当前 Key 不变'
                  : '当前未配置 Key，请填写'
                : undefined
            }
          >
            <Input.Password
              disabled={editing?.source === 'env'}
              autoComplete="new-password"
              placeholder={editing ? '留空则不修改' : 'sk-...'}
            />
          </Form.Item>

          <Form.Item name="models" label="模型列表" extra="留空表示直接透传请求中的模型名">
            <ModelChipEditor value={modelValues} onChange={(models) => form.setFieldValue('models', models)} />
          </Form.Item>

          <Form.Item
            name="systemPrompt"
            label="Provider 内置系统提示词"
            extra="会与全局系统提示词合并，并作为上游第一条强制规则消息。"
          >
            <Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} placeholder="留空表示不配置 Provider 级规则" />
          </Form.Item>

          <Form.Item name="kind" label="角色" extra="保底与并行各自只应启用一个">
            <Select<ProviderKind>
              options={(Object.keys(KIND_LABEL) as ProviderKind[]).map((kind) => ({
                value: kind,
                label: KIND_LABEL[kind],
              }))}
            />
          </Form.Item>

          <Form.Item
            name="priority"
            label="Priority"
            extra="数字越小越先尝试；仅对主路由角色生效"
          >
            <InputNumber min={0} step={1} className="control-full" />
          </Form.Item>

          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}