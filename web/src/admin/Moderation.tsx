/**
 * 内容审核管理页。
 *
 * 四个标签页对应四类资源，生命周期各不相同：
 *   策略      可复用的命名配置（类别 × 敏感度、引擎组合、命中动作）
 *   作用域    全局默认之外的覆盖：Provider 级 / 模型级
 *   引擎      检测库注册表与可用性（未安装的库显示为不可用，策略勾选也不会生效）
 *   审计      审核命中留痕，可按阶段与类别过滤
 *
 * 总开关和输出侧开关在「设置」页，这里只负责策略本身。
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';

import { adminApi } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../lib/format';
import type {
  MaliciousBehaviorAction,
  ModerationBindingDTO,
  ModerationCategory,
  ModerationCategorySettingDTO,
  ModerationCombineMode,
  ModerationDetectorInfoDTO,
  ModerationDetectorSettingDTO,
  ModerationEventDTO,
  ModerationOutputAction,
  ModerationPolicyDTO,
  ModerationPolicyInput,
} from '@shared/api';

const ACTION_OPTIONS: Array<{ label: string; value: MaliciousBehaviorAction }> = [
  { label: '封禁该 IP（永久）', value: 'ban' },
  { label: '拦截该 IP（临时）', value: 'block' },
  { label: '限流该 IP（临时）', value: 'throttle' },
  { label: '空回复（200 + 空消息）', value: 'empty' },
  { label: '报错（返回错误码）', value: 'error' },
  { label: '返回指定响应内容', value: 'response' },
];

/**
 * 不可用引擎的原因提示。
 * 只显示「未安装」会让人无从下手，这里把加载失败原因与可直接执行的修复命令
 * 一起挂到 Tag 上；可用引擎不挂提示，避免鼠标经过时弹出无意义空框。
 */
function reasonTooltip(info: ModerationDetectorInfoDTO | undefined) {
  if (!info || info.available || !info.reason) return undefined;
  return (
    <Space direction="vertical" size={0}>
      <span>{info.reason}</span>
      {info.hint ? <Typography.Text style={{ color: 'inherit', fontSize: 12 }}>{info.hint}</Typography.Text> : null}
    </Space>
  );
}

const OUTPUT_ACTION_OPTIONS: Array<{ label: string; value: ModerationOutputAction }> = [
  { label: '空回复（清空正文）', value: 'empty' },
  { label: '报错（返回错误码）', value: 'error' },
  { label: '替换为指定文本', value: 'response' },
];

const COMBINE_OPTIONS: Array<{ label: string; value: ModerationCombineMode }> = [
  { label: 'strict —— 任一引擎命中即拦截', value: 'strict' },
  { label: 'majority —— 超过半数引擎命中', value: 'majority' },
  { label: 'lenient —— 全部引擎命中才拦截', value: 'lenient' },
];

interface CategoryMetaLite {
  category: ModerationCategory;
  label: string;
  parent: ModerationCategory | null;
  defaultSensitivity: number;
}

interface PolicyDraft {
  name: string;
  description: string;
  enabled: boolean;
  isDefault: boolean;
  combineMode: ModerationCombineMode;
  action: MaliciousBehaviorAction;
  outputAction: ModerationOutputAction;
  outputResponse: string;
  response: string;
  holdBackChars: number;
  forbiddenKeywords: string;
}

function toDraft(policy: ModerationPolicyDTO | null): PolicyDraft {
  return {
    name: policy?.name ?? '',
    description: policy?.description ?? '',
    enabled: policy?.enabled ?? true,
    isDefault: policy?.isDefault ?? false,
    combineMode: policy?.combineMode ?? 'strict',
    action: policy?.action ?? 'empty',
    outputAction: policy?.outputAction ?? 'empty',
    outputResponse: policy?.outputResponse ?? '',
    response: policy?.response ?? '',
    holdBackChars: policy?.holdBackChars ?? 96,
    forbiddenKeywords: policy?.forbiddenKeywords ?? '',
  };
}

export function ModerationAdmin() {
  const policies = useAsync(() => adminApi.moderationPolicies(), []);
  const detectors = useAsync(() => adminApi.moderationDetectors(), []);
  const categoriesMeta = useAsync(() => adminApi.moderationCategories(), []);
  const bindings = useAsync(() => adminApi.moderationBindings(), []);
  const providers = useAsync(() => adminApi.providers(), []);

  const detectorInfo = useMemo(
    () => new Map((detectors.data ?? []).map((detector) => [detector.id, detector])),
    [detectors.data],
  );

  return (
    <div className="admin-page">
      <Typography.Title level={4}>内容审核</Typography.Title>
      <Typography.Paragraph type="secondary">
        多层可配置审核：按类别配置识别方向与敏感度，多引擎组合默认「全部放行才通过」，并按
        全局 → Provider → 模型 的作用域逐级覆盖。总开关在「设置」页。
      </Typography.Paragraph>

      <Tabs
        items={[
          {
            key: 'policies',
            label: '策略',
            children: (
              <PoliciesTab
                policies={policies.data ?? []}
                detectorInfo={detectorInfo}
                categoriesMeta={categoriesMeta.data ?? []}
                onChanged={() => policies.reload()}
              />
            ),
          },
          {
            key: 'bindings',
            label: '作用域绑定',
            children: (
              <BindingsTab
                bindings={bindings.data ?? []}
                policies={policies.data ?? []}
                providers={providers.data ?? []}
                onChanged={() => bindings.reload()}
              />
            ),
          },
          {
            key: 'detectors',
            label: '检测引擎',
            children: <DetectorsTab detectors={detectors.data ?? []} />,
          },
          { key: 'events', label: '审计日志', children: <EventsTab /> },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------------ 策略

function PoliciesTab({
  policies,
  detectorInfo,
  categoriesMeta,
  onChanged,
}: {
  policies: ModerationPolicyDTO[];
  detectorInfo: Map<string, ModerationDetectorInfoDTO>;
  categoriesMeta: CategoryMetaLite[];
  onChanged: () => void;
}) {
  const [form] = Form.useForm<PolicyDraft>();
  const [editing, setEditing] = useState<ModerationPolicyDTO | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [categorySettings, setCategorySettings] = useState<ModerationCategorySettingDTO[]>([]);
  const [detectorSettings, setDetectorSettings] = useState<ModerationDetectorSettingDTO[]>([]);

  const labelOf = useMemo(
    () => new Map(categoriesMeta.map((meta) => [meta.category, meta.label])),
    [categoriesMeta],
  );
  const outputAction = Form.useWatch('outputAction', form);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue(toDraft(null));
    // 新策略默认全部类别启用、按各自默认敏感度；引擎按注册表默认归属
    setCategorySettings(
      categoriesMeta.map((meta) => ({
        category: meta.category,
        enabled: true,
        sensitivity: meta.defaultSensitivity,
      })),
    );
    setDetectorSettings(
      [...detectorInfo.values()].map((detector) => ({
        detectorId: detector.id,
        enabled: true,
        categories: detector.nativeCategories ? [] : defaultGenericCategories(detector.id),
      })),
    );
    setModalOpen(true);
  };

  const openEdit = (policy: ModerationPolicyDTO) => {
    setEditing(policy);
    form.setFieldsValue(toDraft(policy));
    setCategorySettings(policy.categories);
    setDetectorSettings(policy.detectors);
    setModalOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const input: ModerationPolicyInput = { ...values, categories: categorySettings, detectors: detectorSettings };
      if (editing) await adminApi.updateModerationPolicy(editing.id, input);
      else await adminApi.createModerationPolicy(input);
      message.success(editing ? '策略已更新' : '策略已创建');
      setModalOpen(false);
      onChanged();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = (policy: ModerationPolicyDTO) => {
    Modal.confirm({
      title: `删除策略「${policy.name}」？`,
      content: '绑定到该策略的作用域会退回上一层（Provider → 全局默认）。',
      okType: 'danger',
      onOk: async () => {
        try {
          await adminApi.deleteModerationPolicy(policy.id);
          message.success('策略已删除');
          onChanged();
        } catch (error) {
          message.error((error as Error).message);
        }
      },
    });
  };

  return (
    <Card
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建策略
        </Button>
      }
    >
      <Table<ModerationPolicyDTO>
        rowKey="id"
        dataSource={policies}
        pagination={false}
        columns={[
          {
            title: '名称',
            dataIndex: 'name',
            render: (name: string, record) => (
              <Space>
                <span>{name}</span>
                {record.isDefault ? <Tag color="blue">默认</Tag> : null}
                {record.enabled ? null : <Tag>已停用</Tag>}
              </Space>
            ),
          },
          { title: '组合模式', dataIndex: 'combineMode', render: (value: ModerationCombineMode) => <Tag>{value}</Tag> },
          {
            title: '启用类别',
            render: (_, record) => `${record.categories.filter((item) => item.enabled).length} / ${record.categories.length}`,
          },
          {
            title: '启用引擎',
            render: (_, record) => {
              const enabled = record.detectors.filter((item) => item.enabled);
              return (
                <Space wrap>
                  {enabled.map((item) => {
                    const info = detectorInfo.get(item.detectorId);
                    return (
                      <Tooltip key={item.detectorId} title={reasonTooltip(info)}>
                        <Tag color={info?.available ? 'green' : 'default'}>
                          {item.detectorId}
                          {info?.available ? '' : '（未安装）'}
                        </Tag>
                      </Tooltip>
                    );
                  })}
                  {enabled.length === 0 ? <Tag>无</Tag> : null}
                </Space>
              );
            },
          },
          { title: '请求动作', dataIndex: 'action', width: 110 },
          { title: '输出动作', dataIndex: 'outputAction', width: 110 },
          {
            title: '操作',
            width: 140,
            render: (_, record) => (
              <Space>
                <Button size="small" onClick={() => openEdit(record)}>
                  编辑
                </Button>
                <Button size="small" danger onClick={() => remove(record)}>
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={modalOpen}
        title={editing ? `编辑策略：${editing.name}` : '新建策略'}
        width={860}
        onCancel={() => setModalOpen(false)}
        onOk={save}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={toDraft(editing)}>
          <div className="settings-grid">
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="例如：严格审核" />
            </Form.Item>
            <Form.Item name="combineMode" label="引擎组合模式" tooltip="默认 strict：任一启用引擎命中即拦截，等价「通过所有库的检测」。">
              <Select options={COMBINE_OPTIONS} />
            </Form.Item>
            <Form.Item name="action" label="请求侧命中动作">
              <Select options={ACTION_OPTIONS} />
            </Form.Item>
            <Form.Item name="outputAction" label="响应侧命中动作">
              <Select options={OUTPUT_ACTION_OPTIONS} />
            </Form.Item>
            <Form.Item name="holdBackChars" label="流式滞后窗口（字符）" tooltip="流式审核保留末尾 N 个字符不立即发出，用于拦住跨块拆词；越大越安全，代价是首字延迟。">
              <InputNumber min={0} max={2000} className="control-full" />
            </Form.Item>
            <Form.Item name="enabled" label="启用策略" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="isDefault" label="设为全局默认" valuePropName="checked" tooltip="全局默认策略互斥，设置后其他策略会自动取消默认。">
              <Switch />
            </Form.Item>
          </div>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} />
          </Form.Item>
          {outputAction === 'response' ? (
            <Form.Item name="outputResponse" label="响应侧替换文本">
              <Input.TextArea rows={2} />
            </Form.Item>
          ) : null}
          <Form.Item name="response" label="请求侧返回文本（请求动作=response 时）">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="forbiddenKeywords" label="自定义违禁词" tooltip="每行或逗号分隔一个；作为内置词库的扩展，优先归入「脏话/辱骂」类别。">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>

        <Typography.Title level={5}>识别方向与敏感度</Typography.Title>
        <CategoryMatrix
          categoriesMeta={categoriesMeta}
          value={categorySettings}
          onChange={setCategorySettings}
        />

        <Typography.Title level={5} style={{ marginTop: 16 }}>
          检测引擎
        </Typography.Title>
        <DetectorMatrix
          detectorInfo={detectorInfo}
          labelOf={labelOf}
          value={detectorSettings}
          onChange={setDetectorSettings}
        />
      </Modal>
    </Card>
  );
}

/**
 * 通用命中引擎的默认归属类别（与后端 defaultDetectorSettings 保持一致）。
 * 只给 profanity：这些库无法区分脏话与仇恨/色情，避免误标严重类别。
 */
function defaultGenericCategories(detectorId: string): ModerationCategory[] {
  if (detectorId === 'obscenity' || detectorId === 'visulima') return ['profanity'];
  return [];
}

function CategoryMatrix({
  categoriesMeta,
  value,
  onChange,
}: {
  categoriesMeta: CategoryMetaLite[];
  value: ModerationCategorySettingDTO[];
  onChange: (next: ModerationCategorySettingDTO[]) => void;
}) {
  const map = new Map(value.map((item) => [item.category, item]));
  const get = (category: ModerationCategory, fallbackSensitivity: number): ModerationCategorySettingDTO =>
    map.get(category) ?? { category, enabled: false, sensitivity: fallbackSensitivity };

  const update = (category: ModerationCategory, patch: Partial<ModerationCategorySettingDTO>, fallbackSensitivity: number) => {
    const current = get(category, fallbackSensitivity);
    const next = new Map(map);
    next.set(category, { ...current, ...patch });
    onChange([...next.values()]);
  };

  return (
    <Table
      rowKey="category"
      size="small"
      pagination={false}
      dataSource={categoriesMeta}
      columns={[
        {
          title: '类别',
          dataIndex: 'label',
          render: (label: string, record) => (
            <Space>
              <span>{label}</span>
              <Tag>{record.category}</Tag>
            </Space>
          ),
        },
        {
          title: '启用',
          width: 90,
          render: (_, record) => (
            <Switch
              size="small"
              checked={get(record.category, record.defaultSensitivity).enabled}
              onChange={(checked) => update(record.category, { enabled: checked }, record.defaultSensitivity)}
            />
          ),
        },
        {
          title: '敏感度（0-100，越高越严格）',
          width: 260,
          render: (_, record) => (
            <InputNumber
              size="small"
              min={0}
              max={100}
              value={get(record.category, record.defaultSensitivity).sensitivity}
              onChange={(next) =>
                update(record.category, { sensitivity: Number(next ?? record.defaultSensitivity) }, record.defaultSensitivity)
              }
            />
          ),
        },
      ]}
    />
  );
}

function DetectorMatrix({
  detectorInfo,
  labelOf,
  value,
  onChange,
}: {
  detectorInfo: Map<string, ModerationDetectorInfoDTO>;
  labelOf: Map<ModerationCategory, string>;
  value: ModerationDetectorSettingDTO[];
  onChange: (next: ModerationDetectorSettingDTO[]) => void;
}) {
  const map = new Map(value.map((item) => [item.detectorId, item]));
  const get = (id: string): ModerationDetectorSettingDTO => map.get(id) ?? { detectorId: id, enabled: false, categories: [] };

  const update = (id: string, patch: Partial<ModerationDetectorSettingDTO>) => {
    const next = new Map(map);
    next.set(id, { ...get(id), ...patch });
    onChange([...next.values()]);
  };

  const allCategories = [...labelOf.keys()];

  return (
    <Table
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={[...detectorInfo.values()]}
      columns={[
        {
          title: '引擎',
          render: (_, record) => (
            <Space direction="vertical" size={0}>
              <Space>
                <span>{record.label}</span>
                <Tooltip title={reasonTooltip(record)}>
                  <Tag color={record.available ? 'green' : 'default'}>{record.available ? '可用' : '未安装'}</Tag>
                </Tooltip>
                {record.nativeCategories ? <Tag color="purple">原生分类</Tag> : <Tag>通用命中</Tag>}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {record.description}
              </Typography.Text>
              {!record.available && record.reason ? (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  {record.reason}；{record.hint ?? '重装依赖后重启服务'}
                </Typography.Text>
              ) : null}
            </Space>
          ),
        },
        {
          title: '启用',
          width: 90,
          render: (_, record) => (
            <Switch
              size="small"
              checked={get(record.id).enabled}
              disabled={!record.available}
              onChange={(checked) => update(record.id, { enabled: checked })}
            />
          ),
        },
        {
          title: '命中归属类别（仅通用命中引擎）',
          width: 320,
          render: (_, record) =>
            record.nativeCategories ? (
              <Typography.Text type="secondary">该引擎自带类别，无需映射</Typography.Text>
            ) : (
              <Select
                mode="multiple"
                size="small"
                style={{ width: '100%' }}
                placeholder="选择该引擎命中时归属的类别"
                value={get(record.id).categories}
                options={allCategories.map((category) => ({ label: labelOf.get(category) ?? category, value: category }))}
                onChange={(next) => update(record.id, { categories: next })}
              />
            ),
        },
      ]}
    />
  );
}

// ------------------------------------------------------------------ 绑定

function BindingsTab({
  bindings,
  policies,
  providers,
  onChanged,
}: {
  bindings: ModerationBindingDTO[];
  policies: ModerationPolicyDTO[];
  providers: Array<{ id: number; name: string; displayName: string }>;
  onChanged: () => void;
}) {
  const [scopeType, setScopeType] = useState<'provider' | 'model'>('provider');
  const [providerId, setProviderId] = useState<number | null>(null);
  const [model, setModel] = useState('');
  const [policyId, setPolicyId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const policyOptions = policies.filter((policy) => policy.enabled).map((policy) => ({ label: policy.name, value: policy.id }));
  const providerOptions = providers.map((provider) => ({ label: provider.displayName || provider.name, value: provider.id }));

  const save = async () => {
    if (!providerId || !policyId) {
      message.warning('请选择 Provider 与策略');
      return;
    }
    if (scopeType === 'model' && !model.trim()) {
      message.warning('模型级绑定必须填写模型名');
      return;
    }
    setSaving(true);
    try {
      await adminApi.saveModerationBinding({
        scopeType,
        providerId,
        model: scopeType === 'model' ? model.trim() : null,
        policyId,
      });
      message.success('绑定已保存');
      setModel('');
      onChanged();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await adminApi.deleteModerationBinding(id);
      message.success('绑定已删除');
      onChanged();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert
        type="info"
        showIcon
        message="作用域层级：模型级 > Provider 级 > 全局默认"
        description="请求侧审核使用全局默认策略（输入与 Provider 无关）；响应侧审核按实际 Provider 与实际模型解析，未命中绑定则向上继承。"
      />
      <Card title="新增 / 覆盖绑定">
        <Space wrap>
          <Select
            style={{ width: 140 }}
            value={scopeType}
            onChange={setScopeType}
            options={[
              { label: 'Provider 级', value: 'provider' },
              { label: '模型级', value: 'model' },
            ]}
          />
          <Select
            style={{ width: 220 }}
            placeholder="选择 Provider"
            value={providerId ?? undefined}
            onChange={(value) => setProviderId(value)}
            options={providerOptions}
          />
          {scopeType === 'model' ? (
            <Input style={{ width: 220 }} placeholder="模型名（精确匹配）" value={model} onChange={(event) => setModel(event.target.value)} />
          ) : null}
          <Select
            style={{ width: 220 }}
            placeholder="选择策略"
            value={policyId ?? undefined}
            onChange={(value) => setPolicyId(value)}
            options={policyOptions}
          />
          <Button type="primary" loading={saving} onClick={save}>
            保存绑定
          </Button>
        </Space>
      </Card>
      <Table<ModerationBindingDTO>
        rowKey="id"
        dataSource={bindings}
        pagination={false}
        columns={[
          { title: '作用域', dataIndex: 'scopeType', width: 110, render: (value: string) => <Tag>{value}</Tag> },
          { title: 'Provider', dataIndex: 'providerName', render: (value: string | null) => value ?? '—' },
          { title: '模型', dataIndex: 'model', render: (value: string | null) => value ?? '（全部）' },
          { title: '策略', dataIndex: 'policyName', render: (value: string | null) => value ?? '—' },
          { title: '创建时间', dataIndex: 'createdAt', render: (value: string) => formatDateTime(value) },
          {
            title: '操作',
            width: 100,
            render: (_, record) => (
              <Button size="small" danger onClick={() => remove(record.id)}>
                删除
              </Button>
            ),
          },
        ]}
      />
    </Space>
  );
}

// ------------------------------------------------------------------ 引擎

function DetectorsTab({ detectors }: { detectors: ModerationDetectorInfoDTO[] }) {
  return (
    <Card>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="引擎为可选依赖，未安装时自动禁用，不影响服务启动"
        description="当前内置适配器：内置分类词库（原生分类）、whitz-word-detector、@visulima/content-safety、obscenity。新增引擎需要实现 ModerationDetector 接口并注册。排查未安装原因可执行 npm run moderation:doctor。"
      />
      <Table<ModerationDetectorInfoDTO>
        rowKey="id"
        dataSource={detectors}
        pagination={false}
        columns={[
          { title: 'id', dataIndex: 'id', width: 180 },
          { title: '名称', dataIndex: 'label' },
          { title: '依赖', dataIndex: 'dependency', width: 200, render: (value: string | null) => value ?? '内置' },
          { title: '说明', dataIndex: 'description' },
          {
            title: '类别能力',
            render: (_, record) => (record.nativeCategories ? '原生分类' : '通用命中'),
          },
          {
            title: '语言',
            dataIndex: 'languages',
            render: (value: string[]) => value.join(', '),
          },
          {
            title: '状态',
            width: 140,
            render: (_, record) => (
              <Space direction="vertical" size={0}>
                <Tooltip title={reasonTooltip(record)}>
                  <Tag color={record.available ? 'green' : 'default'}>{record.available ? '可用' : '未安装'}</Tag>
                </Tooltip>
                {!record.available && record.reason ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {record.reason}
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ 审计

function EventsTab() {
  const [stage, setStage] = useState<'input' | 'output' | undefined>(undefined);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const events = useAsync(
    () => adminApi.moderationEvents({ limit: 100, stage, blockedOnly: blockedOnly || undefined }),
    [stage, blockedOnly],
  );

  return (
    <Card
      extra={
        <Space>
          <Select
            allowClear
            style={{ width: 140 }}
            placeholder="全部阶段"
            value={stage}
            onChange={(value) => setStage(value)}
            options={[
              { label: '请求侧', value: 'input' },
              { label: '响应侧', value: 'output' },
            ]}
          />
          <Switch checked={blockedOnly} onChange={setBlockedOnly} checkedChildren="仅命中" unCheckedChildren="全部" />
          <Button icon={<ReloadOutlined />} onClick={() => events.reload()}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table<ModerationEventDTO>
        rowKey="id"
        dataSource={events.data?.items ?? []}
        pagination={false}
        scroll={{ x: 1100 }}
        columns={[
          { title: '时间', dataIndex: 'occurredAt', width: 170, render: (value: string) => formatDateTime(value) },
          { title: '阶段', dataIndex: 'stage', width: 90, render: (value: string) => <Tag>{value}</Tag> },
          {
            title: '类别',
            dataIndex: 'categories',
            render: (value: ModerationCategory[]) => (
              <Space wrap>
                {value.map((category) => (
                  <Tag key={category} color="red">
                    {category}
                  </Tag>
                ))}
              </Space>
            ),
          },
          { title: '引擎', dataIndex: 'detectorIds', render: (value: string[]) => value.join(', ') },
          { title: '分数', dataIndex: 'score', width: 80, render: (value: number | null) => (value === null ? '—' : value.toFixed(2)) },
          { title: '命中片段', dataIndex: 'matched', render: (value: string[]) => value.join(' | ') },
          { title: '动作', dataIndex: 'action', width: 90 },
          {
            title: '结论',
            dataIndex: 'blocked',
            width: 90,
            render: (value: boolean) => <Tag color={value ? 'red' : 'green'}>{value ? '拦截' : '放行'}</Tag>,
          },
          { title: '策略', dataIndex: 'policyName', render: (value: string | null) => value ?? '—' },
          { title: 'IP', dataIndex: 'ip', render: (value: string | null) => value ?? '—' },
        ]}
      />
      <Descriptions size="small" column={1} style={{ marginTop: 12 }}>
        <Descriptions.Item label="说明">
          仅记录命中事件（放行判定不会入库），随请求明细同批落盘；保留天数由「设置」页的审核审计日志保留天数控制。
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
