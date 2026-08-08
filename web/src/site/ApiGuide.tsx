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
import { apiBase } from './origin';

type Snippet = 'curl' | 'fetch' | 'sdk';

function buildSnippets(base: string): Record<Snippet, string> {
  return {
    curl: `curl ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": false
  }'`,

    fetch: `const response = await fetch('${base}/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
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
  const base = useMemo(apiBase, []);
  const snippets = useMemo(() => buildSnippets(base), [base]);
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
        desc="复制下面的请求示例，即可在命令行、前端或已有 SDK 项目中发起一次对话请求。"
      />

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
            <span>API Key</span>
            <code>任意字符 / 可留空</code>
          </div>
          <div className="request-row">
            <span>模型名称</span>
            <code>省略则由路由自动选择</code>
            <Tag color="blue">可选</Tag>
          </div>
        </div>

        <div className="api-snippet">
          <div className="api-snippet-head">
            <Segmented
              size="small"
              value={active}
              onChange={(value) => setActive(value as Snippet)}
              options={[
                { label: 'curl', value: 'curl' },
                { label: 'fetch', value: 'fetch' },
                { label: 'OpenAI SDK', value: 'sdk' },
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