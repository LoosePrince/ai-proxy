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

import { useCallback, useEffect, useState } from 'react';
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
  Tabs,
  Tag,
  Tooltip,
  message,
} from 'antd';

import { adminApi } from '../api/client';
import { ModelChipEditor } from '../components/ModelChipEditor';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../lib/format';
import { ProviderScriptEditor } from './ProviderScriptEditor';
import { ProviderVariableEditor, scanProviderVariableNames, syncProviderVariables } from './ProviderVariableEditor';
import type {
  PriorityGroupDTO,
  ProviderDTO,
  ProviderKind,
  ProviderRequestMode,
  ProviderTestResult,
  ProviderVariableDefinition,
  RoutingRule,
} from '@shared/api';

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

const DEFAULT_REQUEST_SCRIPT = `module.exports = async ({ request, model, variables, fetch, signal }) => {
  const response = await fetch(variables.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: \`Bearer \${variables.api_token}\`,
    },
    body: JSON.stringify({ ...request.payload, model }),
    signal,
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/json',
    body: await response.json(),
    actualModel: model,
  };
};`;

interface FormValues {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  systemPrompt: string;
  requestMode: ProviderRequestMode;
  requestScript: string;
  variables: ProviderVariableDefinition[];
  variablesAutoSync: boolean;
  mainScript: string;
  scheduleEnabled: boolean;
  scheduleCron: string;
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
  const [testing, setTesting] = useState(false);
  const [runningMain, setRunningMain] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [testPayload, setTestPayload] = useState('{\n  "messages": [{"role": "user", "content": "ping"}]\n}');
  const [form] = Form.useForm<FormValues>();
  const modelValues = Form.useWatch('models', form) ?? [];
  const requestMode = Form.useWatch('requestMode', form) ?? 'openai';
  const variableValues = Form.useWatch('variables', form) ?? [];
  const variablesAutoSync = Form.useWatch('variablesAutoSync', form) ?? false;
  const requestScriptValue = Form.useWatch('requestScript', form) ?? '';
  const mainScriptValue = Form.useWatch('mainScript', form) ?? '';
  const scheduleEnabledValue = Form.useWatch('scheduleEnabled', form) ?? false;

  useEffect(() => {
    if (!variablesAutoSync || requestMode !== 'script') return;
    const names = scanProviderVariableNames(requestScriptValue, mainScriptValue);
    const current = form.getFieldValue('variables') ?? [];
    const merged = syncProviderVariables(current, names);
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      const referenced = new Set(names);
      const removed = current.map((variable: ProviderVariableDefinition) => variable.name).filter((name: string) => !referenced.has(name));
      if (removed.length > 0) message.warning(`代码已移除变量引用：${removed.join('、')}`);
      form.setFieldValue('variables', merged);
    }
  }, [form, mainScriptValue, requestMode, requestScriptValue, variablesAutoSync]);

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
      requestMode: 'openai',
      requestScript: '',
      variables: [],
      variablesAutoSync: false,
      mainScript: '',
      scheduleEnabled: false,
      scheduleCron: '',
      kind: 'primary',
      priority: 0,
      enabled: true,
    });
    setTestResult(null);
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
        requestMode: record.requestMode,
        requestScript: record.requestScript,
        variables: record.variables,
        variablesAutoSync: record.variablesAutoSync,
        mainScript: record.mainScript,
        scheduleEnabled: record.scheduleEnabled,
        scheduleCron: record.scheduleCron,
        kind: record.kind,
        priority: record.priority,
        enabled: record.enabled,
      });
      setTestResult(null);
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

  const testRequest = useCallback(async () => {
    const values = await form.validateFields();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(testPayload) as Record<string, unknown>;
    } catch {
      message.error('测试请求 JSON 格式无效');
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const variables = Object.fromEntries(
        (values.variables ?? []).filter((item) => item.name).map((item) => [item.name, item.defaultValue]),
      );
      const result = await adminApi.testProvider({
        providerId: editing?.id,
        provider: {
          name: values.name,
          baseUrl: values.baseUrl,
          apiKey: values.apiKey?.trim() || undefined,
          models: values.models,
          systemPrompt: values.systemPrompt,
          requestMode: values.requestMode,
          requestScript: values.requestScript,
          variables: values.variables,
          variablesAutoSync: values.variablesAutoSync,
          mainScript: values.mainScript,
          scheduleEnabled: values.scheduleEnabled,
          scheduleCron: values.scheduleCron,
          kind: values.kind,
          priority: values.priority,
          enabled: values.enabled,
        },
        model: typeof payload.model === 'string' ? payload.model : values.models[0],
        payload,
        variables,
      });
      setTestResult(result);
    } catch (error) {
      message.error((error as Error).message || '请求测试失败');
    } finally {
      setTesting(false);
    }
  }, [editing, form, testPayload]);

  const runMain = useCallback(async () => {
    if (!editing || !mainScriptValue.trim()) return;
    setRunningMain(true);
    try {
      const result = await adminApi.runProviderMain(editing.id);
      message.success(result.updated.length > 0 ? `主入口执行成功，已更新：${result.updated.join('、')}` : '主入口执行成功，变量未变化');
      const refreshed = await adminApi.providers();
      const next = refreshed.find((provider) => provider.id === editing.id);
      if (next) {
        setEditing(next);
        form.setFieldValue('variables', next.variables);
      }
      reloadAll();
    } catch (error) {
      message.error((error as Error).message || '主入口执行失败');
    } finally {
      setRunningMain(false);
    }
  }, [editing, form, mainScriptValue, reloadAll]);

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
              title: '请求模式',
              dataIndex: 'requestMode',
              render: (mode: ProviderRequestMode) =>
                mode === 'script' ? <Tag color="purple">Node.js 脚本</Tag> : <Tag color="cyan">OpenAI 兼容</Tag>,
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
        width={900}
        title={editing ? `编辑 ${editing.name}` : '新增 Provider'}
        onCancel={closeModal}
        footer={
          <Space>
            <Button onClick={closeModal}>取消</Button>
            <Button loading={testing} onClick={() => void testRequest()}>请求测试</Button>
            <Button type="primary" loading={saving} onClick={() => void submit()}>保存</Button>
          </Space>
        }
        confirmLoading={saving}
        destroyOnClose
        maskClosable={false}
      >
        <Form<FormValues> form={form} layout="vertical" requiredMark="optional">
          <Tabs defaultActiveKey="config" className="provider-editor-tabs">
            <Tabs.TabPane tab="配置与变量" key="config">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请填写名称' }]}
            extra={editing?.source === 'env' ? '环境变量来源的 Provider 不可改名' : undefined}
          >
            <Input disabled={editing?.source === 'env'} placeholder="provider-a" />
          </Form.Item>

          <Form.Item name="requestMode" label="添加模式" extra="标准模式使用 OpenAI 兼容协议；脚本模式完全由 Node.js 源码决定请求方式。">
            <Select<ProviderRequestMode>
              onChange={(mode) => {
                if (mode === 'script' && !form.getFieldValue('requestScript')) {
                  form.setFieldValue('requestScript', DEFAULT_REQUEST_SCRIPT);
                }
                if (mode === 'script' && !(form.getFieldValue('variables') ?? []).length) {
                  form.setFieldValue('variables', [
                    { name: 'endpoint', label: '请求地址', type: 'text', defaultValue: '', required: true },
                    { name: 'api_token', label: 'API Token', type: 'password', defaultValue: '', required: true },
                  ]);
                }
              }}
              options={[
                { value: 'openai', label: 'OpenAI 兼容请求' },
                { value: 'script', label: 'Node.js 脚本' },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label={requestMode === 'script' ? '默认 Base URL（可选）' : 'Base URL'}
            rules={[
              ...(requestMode === 'openai' ? [{ required: true, message: '请填写 Base URL' }] : []),
              {
                validator: async (_, value) => {
                  if (!value || String(value).startsWith('http://') || String(value).startsWith('https://')) return;
                  throw new Error('必须以 http:// 或 https:// 开头');
                },
              },
            ]}
            extra={requestMode === 'script' ? '脚本可自行调用任意地址，此字段仅作为 Provider 元数据。' : undefined}
          >
            <Input disabled={editing?.source === 'env'} placeholder={requestMode === 'script' ? '可留空' : 'https://api.example.com/v1'} />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key"
            rules={requestMode === 'openai' && (!editing || !editing.hasApiKey) ? [{ required: true, message: '请填写 API Key' }] : []}
            extra={
              requestMode === 'script'
                ? '脚本模式不强制使用 API Key，可在源码或变量中自行处理认证。'
                : editing
                  ? editing.hasApiKey
                    ? '留空表示保持当前 Key 不变'
                    : '当前未配置 Key，请填写'
                  : undefined
            }
          >
            <Input.Password
              disabled={editing?.source === 'env'}
              autoComplete="new-password"
              placeholder={requestMode === 'script' ? '可留空' : editing ? '留空则不修改' : 'sk-...'}
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

          {requestMode === 'script' ? (
            <ProviderVariableEditor form={form} autoSync={variablesAutoSync} />
          ) : null}

          <Form.Item label="测试请求 JSON" extra="只发送一次，不写入正式请求日志；model 可放在 JSON 中，也可由模型列表提供。">
            <Input.TextArea className="mono" value={testPayload} onChange={(event) => setTestPayload(event.target.value)} autoSize={{ minRows: 5, maxRows: 12 }} />
          </Form.Item>
          {testResult ? (
            <Alert
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              message={testResult.ok ? `测试成功 · HTTP ${testResult.status} · ${testResult.elapsedMs} ms` : `测试失败 · HTTP ${testResult.status}`}
              description={
                <div>
                  {testResult.error ? <div>{testResult.error}</div> : null}
                  {testResult.response === null ? null : (
                    <pre className="provider-test-result">{JSON.stringify(testResult.response, null, 2)}</pre>
                  )}
                </div>
              }
            />
          ) : null}

          <Form.Item name="kind" label="角色" extra="保底与并行各自只应启用一个">
            <Select<ProviderKind>
              options={(Object.keys(KIND_LABEL) as ProviderKind[]).map((kind) => ({
                value: kind,
                label: KIND_LABEL[kind],
              }))}
            />
          </Form.Item>
          <Form.Item name="priority" label="Priority" extra="数字越小越先尝试；仅对主路由角色生效">
            <InputNumber min={0} step={1} className="control-full" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Tabs.TabPane>
          <Tabs.TabPane tab="脚本代码" key="script" disabled={requestMode !== 'script'}>
            {requestMode === 'script' ? (
            <>
              <Form.Item
                name="requestScript"
                label="Node.js 请求脚本"
                rules={[{ required: true, message: '请填写 Node.js 请求脚本' }]}
                extra="脚本通过 module.exports 导出 async 函数，参数为 { request, model, variables, fetch, signal }。后台脚本视为信任来源，可使用 Node.js 的 require。"
              >
                <ProviderScriptEditor
                  value={requestScriptValue}
                  onChange={(value) => form.setFieldValue('requestScript', value)}
                  disabled={editing?.source === 'env'}
                />
              </Form.Item>

              <Form.Item name="mainScript" label="主入口代码" extra="主入口不会在每次聊天请求中执行，可使用 variables.set(name, value) 更新并持久化变量。">
                <ProviderScriptEditor value={mainScriptValue} onChange={(value) => form.setFieldValue('mainScript', value)} disabled={editing?.source === 'env'} minHeight={260} />
              </Form.Item>
              <Space align="center" wrap>
                <Form.Item name="scheduleEnabled" valuePropName="checked" noStyle>
                  <Switch checkedChildren="启用 UTC cron" unCheckedChildren="关闭 cron" />
                </Form.Item>
                <Form.Item
                  name="scheduleCron"
                  noStyle
                  rules={[
                    {
                      validator: async (_, value) => {
                        if (!form.getFieldValue('scheduleEnabled')) return;
                        if (!String(value ?? '').trim()) throw new Error('请填写 UTC cron 表达式');
                      },
                    },
                  ]}
                >
                  <Input className="mono" placeholder="*/15 * * * *" disabled={!scheduleEnabledValue} />
                </Form.Item>
                <Button loading={runningMain} onClick={() => void runMain()} disabled={!editing || !mainScriptValue.trim()}>
                  立即执行主入口
                </Button>
              </Space>
              <Alert type="info" showIcon message="cron 使用 UTC 时区，格式为：分 时 日 月 周。保存后等待下一次计划时间，不会立即执行。" />
              {editing?.lastRunAt ? (
                <Alert
                  className="provider-script-status"
                  type={editing.lastRunOk ? 'success' : 'error'}
                  showIcon
                  message={`最近执行：${editing.lastRunOk ? '成功' : '失败'} · ${new Date(editing.lastRunAt).toISOString()}`}
                  description={editing.lastRunError ?? undefined}
                />
              ) : null}
            </>
            ) : null}
          </Tabs.TabPane>
        </Tabs>
        </Form>
      </Modal>
    </div>
  );
}