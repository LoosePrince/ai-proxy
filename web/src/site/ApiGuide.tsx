/**
 * API 接入指南。
 *
 * Base 地址不写死：页面本身由该服务提供，所以 window.location.origin 天然正确，
 * 反代换域名 / 改端口 / 局域网访问都自动适配（见 origin.ts）。
 *
 * 示例代码由 base 拼出，并提供 curl / fetch / OpenAI SDK 三种，
 * 覆盖「命令行验证」「前端直连」「已有 SDK 项目改 baseURL」三类接入方式。
 */

import { useMemo, useState } from 'react';
import { Button, Segmented, Tag, Tooltip, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

import { SectionHead } from '../components/SectionHead';
import { Link } from 'react-router-dom';
import { apiBase, apiOrigin } from './origin';

type Snippet = 'curl' | 'fetch' | 'sdk';

function buildSnippets(origin: string, base: string): Record<Snippet, string> {
  return {
    curl: `curl ${base}/responses \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek-reasoner",
    "input": "你好，请先思考再回答",
    "reasoning": { "effort": "high" },
    "stream": false
  }'`,

    fetch: `const response = await fetch('${origin}/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'GPT 4o mini', // 支持相近模型名匹配
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
  }),
});`,

    sdk: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${base}',
  // 本服务不校验 Key，填任意非空字符串即可
  apiKey: 'any',
});

const completion = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '你好' }],
});`,
  };
}

export function ApiGuide() {
  const origin = useMemo(apiOrigin, []);
  const base = useMemo(apiBase, []);
  const snippets = useMemo(() => buildSnippets(origin, base), [origin, base]);
  const [active, setActive] = useState<Snippet>('curl');

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label} 已复制`);
    } catch {
      // 非 HTTPS 或权限受限时剪贴板不可用，明确告知而非静默失败
      message.warning('浏览器拒绝了剪贴板访问，请手动选中复制');
    }
  };

  return (
    <section className="section" id="api-guide" aria-label="API 接入指南">
      <SectionHead
        kicker="API guide"
        title="接入方式"
        desc="Chat Completions 与 Responses 共用同一套路由能力，接口路径中的 /v1 可按客户端习惯保留或省略。"
      />

      <div className="api-guide-toolbar">
        <span>需要完整配置说明？</span>
        <Button type="link"><Link to="/guide">打开使用指南</Link></Button>
      </div>

      <div className="api-card">
        <div className="api-info">
          <div className="request-row">
            <span>API Base</span>
            <code>{base}</code>
            <Tooltip title="复制 API Base">
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                onClick={() => void copy(base, 'API Base')}
                aria-label="复制 API Base"
              />
            </Tooltip>
          </div>
          <div className="request-row">
            <span>兼容端点</span>
            <code>/chat/completions · /responses</code>
            <Tag color="cyan">/v1 可选</Tag>
          </div>
          <div className="request-row">
            <span>API Key</span>
            <code>任意字符 / 可留空</code>
          </div>
          <div className="request-row">
            <span>模型名称</span>
            <code>支持相近名称匹配；省略则自动选择</code>
            <Tag color="blue">可选</Tag>
          </div>
          <div className="request-row">
            <span>思考上下文</span>
            <code>支持 reasoning / thinking / reasoning_content</code>
          </div>
        </div>

        <div className="api-snippet">
          <div className="api-snippet-head">
            <Segmented
              size="small"
              value={active}
              onChange={(value) => setActive(value as Snippet)}
              options={[
                { label: 'Responses', value: 'curl' },
                { label: 'Chat fetch', value: 'fetch' },
                { label: 'Chat SDK', value: 'sdk' },
              ]}
            />
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              onClick={() => void copy(snippets[active], '示例代码')}
            >
              复制
            </Button>
          </div>
          <pre className="code-block">{snippets[active]}</pre>
        </div>
      </div>
    </section>
  );
}