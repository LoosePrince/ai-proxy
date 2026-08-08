/**
 * 贡献 API 区块。
 *
 * 旧实现用 innerHTML 三层字符串拼接渲染列表，并手写 escapeHtml 防注入 ——
 * 贡献者名称、模型名都来自用户提交，一处漏转义就是 XSS。React 默认转义，
 * 这类风险从根上消失。
 *
 * 提交是一个长耗时操作：后端会逐个模型真实调用上游验证（每个最多 20s）。
 * 因此需要明确的进行中态，且失败时把逐模型结果完整回显 ——
 * 只说「验证失败」对贡献者毫无帮助。
 */

import { useState } from 'react';
import { Avatar, Button, Empty, Form, Input, List, Skeleton, Space, Tag, Tooltip } from 'antd';
import { AnimatePresence, motion } from 'framer-motion';

import { ApiError, publicApi } from '../api/client';
import { SectionHead } from '../components/SectionHead';
import { useAsync } from '../hooks/useAsync';
import { formatCount } from '../lib/format';
import type { ContributionModelResult, ContributionSubmitResult } from '@shared/api';

interface FormValues {
  contributor: string;
  baseUrl: string;
  apiKey: string;
  models: string;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'ok'; message: string; results: ContributionModelResult[] }
  | { kind: 'fail'; message: string; results: ContributionModelResult[] };

/** 后端 422 会把逐模型结果放在错误体里，这里取出来供回显 */
function resultsFromError(error: unknown): ContributionModelResult[] {
  if (!(error instanceof ApiError)) return [];
  const payload = error.payload as { results?: ContributionModelResult[] } | null;
  return Array.isArray(payload?.results) ? payload.results : [];
}

function ModelResults({ results }: { results: ContributionModelResult[] }) {
  if (results.length === 0) return null;

  return (
    <ul className="model-results">
      {results.map((result) => (
        <li key={result.model}>
          <Tag color={result.ok ? 'green' : 'red'}>{result.ok ? '通过' : '失败'}</Tag>
          <code>{result.model}</code>
          <span className="model-result-detail">{result.ok ? result.reply : result.error}</span>
        </li>
      ))}
    </ul>
  );
}

function ContributionList() {
  const list = useAsync(() => publicApi.contributions(), []);

  if (list.status === 'loading' || list.status === 'idle') {
    return <Skeleton active paragraph={{ rows: 4 }} />;
  }

  if (list.status === 'error') {
    return (
      <Empty description={`贡献记录加载失败：${list.error}`}>
        <Button onClick={list.reload}>重试</Button>
      </Empty>
    );
  }

  const items = list.data ?? [];
  if (items.length === 0) {
    return <Empty description="暂无贡献记录，提交通过验证的服务后会显示在这里" />;
  }

  return (
    <List
      className="contribution-list"
      dataSource={items}
      renderItem={(item) => (
        <List.Item
          key={item.id}
          extra={
            <Tag color={item.enabled ? 'green' : 'default'}>{item.enabled ? '已启用' : '待启用'}</Tag>
          }
        >
          <List.Item.Meta
            avatar={
              <Avatar src={item.avatarUrl ?? undefined}>
                {item.displayName.slice(0, 1).toUpperCase()}
              </Avatar>
            }
            title={item.displayName}
            description={
              <Space size={4} wrap>
                <Tooltip title={item.models.join('、') || '未公开模型'}>
                  <Tag>{item.modelCount ? `${formatCount(item.modelCount)} 个模型` : '未公开模型'}</Tag>
                </Tooltip>
                <span className="contribution-base">{item.baseUrl}</span>
              </Space>
            }
          />
        </List.Item>
      )}
    />
  );
}

export function Contribute() {
  const [form] = Form.useForm<FormValues>();
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const [listKey, setListKey] = useState(0);

  const submit = async (values: FormValues) => {
    setState({ kind: 'submitting' });

    try {
      const result: ContributionSubmitResult = await publicApi.submitContribution(values);
      form.resetFields();
      setState({
        kind: 'ok',
        message: `${result.action === 'updated' ? '贡献已更新' : '贡献已创建'}，全部模型验证通过。该 Provider 默认关闭，等待管理员启用。`,
        results: result.results,
      });
      // 列表重挂载以拉取最新数据
      setListKey((key) => key + 1);
    } catch (error) {
      setState({
        kind: 'fail',
        message: (error as Error).message,
        results: resultsFromError(error),
      });
    }
  };

  const submitting = state.kind === 'submitting';

  return (
    <section className="section" id="contribute" aria-label="贡献 API 服务">
      <SectionHead
        kicker="Contribute"
        title="贡献 API 服务"
        desc="提交可用的 OpenAI 兼容 API。系统会逐个真实调用你填写的模型，全部通过后保存为待启用的贡献 Provider。"
      />

      <div className="contribution-card">
        <div className="contribution-panel">
          <div className="panel-heading">
            <span className="panel-kicker">提交服务</span>
            <h3>分享你的 API 节点</h3>
            <p>凭据仅用于可用性验证和转发；公开列表中的邮箱 ID 会使用星号脱敏，并移除邮箱后缀。</p>
          </div>
          <Form<FormValues> form={form} layout="vertical" onFinish={submit} disabled={submitting}>
          <Form.Item
            name="contributor"
            label="邮箱或 GitHub 用户 ID"
            rules={[{ required: true, message: '请填写邮箱或 GitHub 用户 ID' }]}
          >
            <Input placeholder="例如 123456@qq.com 或 github-user" autoComplete="off" />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[
              { required: true, message: '请填写 Base URL' },
              { pattern: /^https?:\/\//i, message: '必须以 http:// 或 https:// 开头' },
            ]}
          >
            <Input placeholder="https://api.example.com/v1" autoComplete="off" />
          </Form.Item>

          <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: '请填写 API Key' }]}>
            <Input.Password placeholder="sk-..." autoComplete="off" />
          </Form.Item>

          <Form.Item
            name="models"
            label="模型列表"
            extra="逗号或换行分隔，最多 20 个。每个模型都会被真实调用一次以确认可用。"
            rules={[{ required: true, message: '至少填写一个模型名' }]}
          >
            <Input.TextArea rows={3} placeholder={'model-a, model-b'} />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={submitting}>
            {submitting ? '正在逐个验证模型…' : '提交并验证'}
          </Button>
        </Form>

        <AnimatePresence mode="wait">
          {state.kind !== 'idle' && (
            <motion.div
              key={state.kind}
              className={`contribution-status ${state.kind}`}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              {state.kind === 'submitting' ? (
                <span>正在验证 Base URL、API Key 与模型列表，单个模型最长等待 20 秒。</span>
              ) : (
                <>
                  <span>{state.message}</span>
                  <ModelResults results={state.results} />
                </>
              )}
            </motion.div>
          )}
          </AnimatePresence>
        </div>

        <div className="contribution-list-panel">
          <div className="panel-heading panel-heading-compact">
            <span className="panel-kicker">Community</span>
            <h3>社区贡献节点</h3>
            <p>通过验证的服务会在管理员启用后加入路由池。</p>
          </div>
          <ContributionList key={listKey} />
        </div>
      </div>
    </section>
  );
}