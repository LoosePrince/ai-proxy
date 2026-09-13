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
  Modal,
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
  ModelHealthRoutingMode,
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

const MODEL_HEALTH_MODE_OPTIONS: Array<{ label: string; value: ModelHealthRoutingMode }> = [
  { label: '默认（当前行为，不参考模型状态）', value: 'random' },
  { label: '优先尝试异常或无流量的模型', value: 'prefer-unhealthy' },
  { label: '首个尝试用于探测异常/无流量模型，后续优先正常模型', value: 'probe-unhealthy-first' },
];

const IDE_ACTION_OPTIONS: Array<{ label: string; value: RequestBehaviorAction }> = [
  { label: '忽略请求（200 + 空消息）', value: 'ignore' },
  { label: '失败（返回错误码）', value: 'error' },
  { label: '去除用户提供的系统提示词后继续', value: 'strip-system-prompt' },
  { label: '仅提交 user 消息', value: 'only-user-messages' },
];

const MALICIOUS_ACTION_OPTIONS: Array<{ label: string; value: MaliciousBehaviorAction }> = [
  { label: '封禁该 IP（写入黑名单，永久拒绝）', value: 'ban' },
  { label: '拦截该 IP（临时封禁一段时间）', value: 'block' },
  { label: '限流该 IP（一段时间内拒绝）', value: 'throttle' },
  { label: '空回复（200 + 空消息）', value: 'empty' },
  { label: '报错（返回错误码）', value: 'error' },
  { label: '返回指定响应内容', value: 'response' },
];

type BehaviorConfigTarget = 'ide' | 'malicious';
type PromptConfigValues = Pick<SettingsDTO, 'globalSystemPrompt'>;
type BehaviorConfigValues = Pick<
  SettingsDTO,
  'ideRequestAction' | 'maliciousRequestAction' | 'maliciousResponse' | 'maliciousThrottleMinutes' | 'forbiddenKeywords'
>;

function SettingsForm({ initial, onSaved }: { initial: SettingsDTO; onSaved: () => void }) {
  const [form] = Form.useForm<SettingsDTO>();
  const [promptConfigForm] = Form.useForm<PromptConfigValues>();
  const [behaviorConfigForm] = Form.useForm<BehaviorConfigValues>();
  const [saving, setSaving] = useState(false);
  const [promptConfigOpen, setPromptConfigOpen] = useState(false);
  const [behaviorConfigTarget, setBehaviorConfigTarget] = useState<BehaviorConfigTarget | null>(null);
  const promptEnabled = Form.useWatch('globalSystemPromptEnabled', form) === true;
  const ideHandlingEnabled = Form.useWatch('ideRequestHandlingEnabled', form) === true;
  const maliciousHandlingEnabled = Form.useWatch('maliciousRequestHandlingEnabled', form) === true;
  const moderationEnabled = Form.useWatch('moderationEnabled', form) === true;
  const moderationOutputEnabled = Form.useWatch('moderationOutputEnabled', form) === true;

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

  const openPromptConfig = () => {
    promptConfigForm.setFieldsValue({ globalSystemPrompt: form.getFieldValue('globalSystemPrompt') });
    setPromptConfigOpen(true);
  };

  const savePromptConfig = async () => {
    const values = await promptConfigForm.validateFields();
    form.setFieldsValue(values);
    setPromptConfigOpen(false);
  };

  const openBehaviorConfig = (target: BehaviorConfigTarget) => {
    behaviorConfigForm.setFieldsValue({
      ideRequestAction: form.getFieldValue('ideRequestAction'),
      maliciousRequestAction: form.getFieldValue('maliciousRequestAction'),
      maliciousResponse: form.getFieldValue('maliciousResponse'),
      maliciousThrottleMinutes: form.getFieldValue('maliciousThrottleMinutes'),
      forbiddenKeywords: form.getFieldValue('forbiddenKeywords'),
    });
    setBehaviorConfigTarget(target);
  };

  const saveBehaviorConfig = async () => {
    const values = await behaviorConfigForm.validateFields();
    if (behaviorConfigTarget === 'ide') {
      form.setFieldValue('ideRequestAction', values.ideRequestAction);
    }
    if (behaviorConfigTarget === 'malicious') {
      form.setFieldsValue({
        maliciousRequestAction: values.maliciousRequestAction,
        maliciousResponse: values.maliciousResponse,
        maliciousThrottleMinutes: values.maliciousThrottleMinutes,
        forbiddenKeywords: values.forbiddenKeywords,
      });
    }
    setBehaviorConfigTarget(null);
  };

  return (
    <>
      <Form form={form} layout="vertical" initialValues={initial} onFinish={submit}>
      <div className="settings-grid">
        <Form.Item
          name="adminEntryEnabled"
          label="首页显示管理后台按钮"
          valuePropName="checked"
          tooltip="关闭后只隐藏首页入口，不影响直接访问 /admin，也不改变后台鉴权。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="projectUrl"
          label="项目地址"
          rules={[{ required: true, type: 'url', message: '请输入有效的项目地址' }]}
          tooltip="用于指南页面和页脚的项目链接。"
        >
          <Input placeholder="https://github.com/LoosePrince/ai-proxy" />
        </Form.Item>

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
          name="publicDetailedStatsEnabled"
          label="启用公开详细统计"
          valuePropName="checked"
          tooltip="开放 /api/public-stats/detailed 与首页的「详细状态页」入口。只披露聚合口径，不包含 IP、Provider 名称与请求正文。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="requestCacheEnabled"
          label="启用请求缓存"
          valuePropName="checked"
          tooltip="相同协议、请求参数和流式形态的成功响应会持久化复用，并在超过复用间隔后自动清理。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="requestCacheReuseHours"
          label="请求缓存复用间隔（小时）"
          rules={[{ required: true, message: '必填' }]}
          tooltip="默认只命中 24 小时内生成的缓存；超过此窗口的缓存将由后台自动清理。"
        >
          <InputNumber min={1} max={8760} className="control-full" />
        </Form.Item>

        <Form.Item
          name="fuzzyModelMatchingEnabled"
          label="相近模型匹配"
          valuePropName="checked"
          tooltip="启用后，请求的模型 ID 会优先匹配到声明了近似模型名的 Provider（例如 GPT 4o mini → openai/gpt-4o-mini）。关闭后完全不处理请求中的模型 ID，按未传模型处理。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="modelHealthRoutingMode"
          label="模型健康路由"
          tooltip="基于渠道声明模型的实时健康（30 分钟窗口内的真实上游成败）决定同渠道内的模型尝试顺序。冷却中的模型始终跳过。"
        >
          <Select options={MODEL_HEALTH_MODE_OPTIONS} />
        </Form.Item>

        <Form.Item
          name="blockedErrorMessage"
          label="拦截 / 封禁提示消息"
          tooltip="黑名单封禁、违禁内容触发的拦截与限流返回给客户端的报错内容。"
        >
          <Input placeholder="该 IP 已被禁止访问" />
        </Form.Item>
      </div>

      <Card size="small" title="模型冷却" className="nested-settings-card">
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          同一渠道声明的模型连续失败达到阈值后进入冷却，冷却期间不再被路由选中；
          冷却结束后回到「无流量」状态，获得重新探测的机会。冷却与健康状态随进程重启清零。
        </Typography.Paragraph>
        <div className="settings-grid">
          <Form.Item
            name="modelCooldownFailureThreshold"
            label="连续失败次数阈值"
            tooltip="0 表示不启用模型冷却。仅统计真正打到上游的失败，客户端断开与并行竞速落败不计入。"
          >
            <InputNumber min={0} max={100} className="control-full" />
          </Form.Item>
          <Form.Item
            name="modelCooldownMinutes"
            label="冷却时长（分钟）"
            tooltip="冷却期间该模型视为不可用，路由自动跳过。"
          >
            <InputNumber min={1} max={1440} className="control-full" />
          </Form.Item>
          <Form.Item
            name="modelEmptyResponseCountsAsFailure"
            label="空消息也视为失败"
            valuePropName="checked"
            tooltip="上游返回 200 但正文为空（流式为整段无内容）时，同样计入该模型的健康窗口与冷却计数。"
          >
            <Switch />
          </Form.Item>
        </div>
      </Card>

      <Card size="small" title="同 IP 请求上限（多窗口同时生效）" className="nested-settings-card">
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          每个窗口独立计数、独立判定，任一窗口超限即拒绝该请求，多个上限可以同时生效。0 表示不启用对应窗口。
          限流在统一网关层执行，超限请求不会被读取请求体。
        </Typography.Paragraph>
        <div className="settings-grid">
          <Form.Item
            name="ipRateLimitRpm"
            label="每分钟上限"
            tooltip="0 表示不启用。限流是进程内的滑动窗口，多实例部署时每个实例独立计数。"
          >
            <InputNumber min={0} className="control-full" />
          </Form.Item>
          <Form.Item
            name="ipRateLimitPer10Min"
            label="每 10 分钟上限"
            tooltip="0 表示不启用。"
          >
            <InputNumber min={0} className="control-full" />
          </Form.Item>
          <Form.Item
            name="ipRateLimitPer30Min"
            label="每 30 分钟上限"
            tooltip="0 表示不启用。"
          >
            <InputNumber min={0} className="control-full" />
          </Form.Item>
          <Form.Item
            name="ipRateLimitPerXHours"
            label="自定义窗口内上限"
            tooltip="0 表示不启用。与下方窗口时长搭配生效。"
          >
            <InputNumber min={0} className="control-full" />
          </Form.Item>
          <Form.Item
            name="ipRateLimitHours"
            label="自定义窗口时长（小时）"
            tooltip="例如填 6 + 上限 100，表示同一 IP 每 6 小时最多 100 次请求。"
          >
            <InputNumber min={0} max={8760} className="control-full" />
          </Form.Item>
        </div>
      </Card>

      <div hidden>
        <Form.Item name="globalSystemPrompt">
          <Input />
        </Form.Item>
        <Form.Item name="ideRequestAction">
          <Input />
        </Form.Item>
        <Form.Item name="maliciousRequestAction">
          <Input />
        </Form.Item>
        <Form.Item name="maliciousResponse">
          <Input />
        </Form.Item>
        <Form.Item name="maliciousThrottleMinutes">
          <Input />
        </Form.Item>
        <Form.Item name="forbiddenKeywords">
          <Input />
        </Form.Item>
      </div>

      <Card size="small" title="全局系统提示词" className="nested-settings-card">
        <Space align="center" wrap>
          <Form.Item name="globalSystemPromptEnabled" valuePropName="checked" noStyle>
            <Switch />
          </Form.Item>
          <Typography.Text>启用全局系统提示词</Typography.Text>
          {promptEnabled ? (
            <Button type="link" size="small" onClick={openPromptConfig}>
              配置提示词
            </Button>
          ) : null}
        </Space>
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          开启后会将服务端提示词作为强制规则注入每个 Provider 的第一条上游消息。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="特定 AI 行为处理" className="nested-settings-card">
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          检测在限流、缓存和上游调用前执行。关闭后对应类别不会被检查，已填写的处理方式会保留。
        </Typography.Paragraph>
        <div className="settings-grid">
          <div>
            <Space align="center" wrap>
              <Form.Item name="ideRequestHandlingEnabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
              <Typography.Text>处理 IDE 环境或工具链请求</Typography.Text>
              {ideHandlingEnabled ? (
                <Button type="link" size="small" onClick={() => openBehaviorConfig('ide')}>
                  配置处理方式
                </Button>
              ) : null}
            </Space>
          </div>
          <div>
            <Space align="center" wrap>
              <Form.Item name="maliciousRequestHandlingEnabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
              <Typography.Text>处理恶意行为内容</Typography.Text>
              {maliciousHandlingEnabled ? (
                <Button type="link" size="small" onClick={() => openBehaviorConfig('malicious')}>
                  配置处理方式
                </Button>
              ) : null}
            </Space>
          </div>
        </div>
      </Card>

      <Card size="small" title="多层内容审核" className="nested-settings-card">
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          类别、敏感度、检测引擎与作用域绑定在{' '}
          <Link to="/admin/moderation">内容审核</Link> 页配置。此开关只控制整套系统是否生效。
        </Typography.Paragraph>
        <div className="settings-grid">
          <div>
            <Space align="center" wrap>
              <Form.Item name="moderationEnabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
              <Typography.Text>启用内容审核系统</Typography.Text>
            </Space>
          </div>
          <div>
            <Space align="center" wrap>
              <Form.Item name="moderationInputEnabled" valuePropName="checked" noStyle>
                <Switch disabled={!moderationEnabled} />
              </Form.Item>
              <Typography.Text>审核请求侧内容</Typography.Text>
            </Space>
          </div>
          <div>
            <Space align="center" wrap>
              <Form.Item name="moderationOutputEnabled" valuePropName="checked" noStyle>
                <Switch disabled={!moderationEnabled} />
              </Form.Item>
              <Typography.Text>审核响应侧内容</Typography.Text>
            </Space>
          </div>
          <div>
            <Space align="center" wrap>
              <Form.Item name="moderationOutputStreamEnabled" valuePropName="checked" noStyle>
                <Switch disabled={!moderationEnabled || !moderationOutputEnabled} />
              </Form.Item>
              <Typography.Text>流式响应逐块审核</Typography.Text>
            </Space>
          </div>
          <Form.Item
            name="moderationAuditRetentionDays"
            label="审核审计日志保留天数"
            tooltip="0 表示永不清理；仅影响审核审计表，不影响请求日志。"
          >
            <InputNumber min={0} max={3650} className="control-full" disabled={!moderationEnabled} />
          </Form.Item>
        </div>
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

      <Modal
        title="配置全局系统提示词"
        open={promptConfigOpen}
        okText="确认"
        cancelText="取消"
        destroyOnClose
        onOk={savePromptConfig}
        onCancel={() => setPromptConfigOpen(false)}
      >
        <Typography.Paragraph type="secondary">
          内容会以服务端强制规则注入每个 Provider 上游请求的第一条消息，优先于客户端消息。
        </Typography.Paragraph>
        <Form form={promptConfigForm} layout="vertical">
          <Form.Item
            name="globalSystemPrompt"
            label="内置系统提示词"
            extra="留空时即使开关开启也不会注入内容。请只填写稳定、可长期适用的规则。"
          >
            <Input.TextArea
              autoSize={{ minRows: 6, maxRows: 16 }}
              placeholder="例如：始终使用简体中文回答，并遵守以下业务规则……"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={behaviorConfigTarget === 'ide' ? '配置 IDE 请求处理' : '配置恶意内容处理'}
        open={behaviorConfigTarget !== null}
        okText="确认"
        cancelText="取消"
        destroyOnClose
        onOk={saveBehaviorConfig}
        onCancel={() => setBehaviorConfigTarget(null)}
      >
        <Form form={behaviorConfigForm} layout="vertical">
          {behaviorConfigTarget === 'ide' ? (
            <Form.Item
              name="ideRequestAction"
              label="检测到 IDE 环境或工具链请求后"
              tooltip="检查 system/developer 消息、工具定义和常见 IDE 工具名称。"
              rules={[{ required: true, message: '请选择处理方式' }]}
            >
              <Select options={IDE_ACTION_OPTIONS} />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name="maliciousRequestAction"
                label="检测到违禁提示词后"
                tooltip="覆盖逆序、越狱、破解、攻击和明显违法内容等模式，以及下方自定义违禁词。"
                rules={[{ required: true, message: '请选择处理方式' }]}
              >
                <Select options={MALICIOUS_ACTION_OPTIONS} />
              </Form.Item>
              <Form.Item
                name="maliciousThrottleMinutes"
                label="拦截 / 限流时长（分钟）"
                extra="仅当处理方式为“拦截该 IP”或“限流该 IP”时生效。"
              >
                <InputNumber min={1} className="control-full" />
              </Form.Item>
              <Form.Item
                name="maliciousResponse"
                label="指定响应内容"
                extra="仅当处理方式为“返回指定响应内容”时生效。"
              >
                <Input.TextArea
                  autoSize={{ minRows: 4, maxRows: 10 }}
                  placeholder="请输入要返回给客户端的内容"
                />
              </Form.Item>
              <Form.Item
                name="forbiddenKeywords"
                label="自定义违禁提示词"
                tooltip="每行或逗号分隔一个词；用户消息命中任一词汇即按上述方式处理。"
              >
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  placeholder={'例如：\n泄露公司机密\n攻击内网服务器'}
                />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </>
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
        result.deleted > 0 ? `已清理 ${result.deleted} 条过期请求或缓存记录` : '没有需要清理的记录',
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
          <Tooltip title="按当前保留天数与缓存复用间隔立即执行一次清理，不必等 6 小时的后台周期">
            <Button size="small" loading={sweeping} onClick={() => void sweep()}>
              立即清理过期记录
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
              已落盘 {data.writeQueue.persisted} · 丢弃 {data.writeQueue.dropped} · 正文截断{' '}
              {data.writeQueue.contentDropped}
            </div>
          </div>
          <div>
            <div className="stat-label">限流桶 / 轮转游标 / 临时拦截</div>
            <div className="stat-value">
              {data.counters.ipBuckets} / {data.counters.rotationCursors} /{' '}
              {data.counters.temporaryBlocks + data.counters.temporaryThrottles}
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