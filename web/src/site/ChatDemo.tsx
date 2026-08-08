/**
 * 在线对话测试。
 *
 * 职责切分：
 *   lib/sse.ts   纯解析（缓冲区、帧切分、增量提取）
 *   本组件        会话状态、请求编排、渲染
 *
 * 保留旧实现的全部行为：SSE 流式、Markdown 渲染、非流式降级、
 * Enter 发送 / Shift+Enter 换行、快捷提示词、清空会话。
 *
 * 旧实现把消息直接 innerHTML 写进 DOM 并依赖全局 marked，
 * 这里改为 react-markdown 渲染，模型输出不会被当作 HTML 执行。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Space, Tag } from 'antd';
import { motion } from 'framer-motion';
import Markdown from 'react-markdown';

import { SectionHead } from '../components/SectionHead';
import { createSseState, scanSse, streamSupported } from '../lib/sse';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

const GREETING = '你好，这里是免费 AI API 的在线测试区。直接发送消息即可验证接口是否正常。';

const QUICK_PROMPTS = [
  { label: '适用场景', text: '用三句话介绍免费 AI API 适合什么场景' },
  { label: '生成 fetch 示例', text: '请生成一个调用 /v1/chat/completions 的 JavaScript fetch 示例' },
  { label: '测试接口', text: '帮我测试当前接口是否响应正常' },
];

let messageSeq = 0;
const nextId = () => (messageSeq += 1);

function greetingMessage(): ChatMessage {
  return { id: nextId(), role: 'assistant', content: GREETING };
}

export function ChatDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [greetingMessage()]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  /** 只更新目标助手消息的内容，避免流式过程中重建整个列表 */
  const patchMessage = useCallback((id: number, content: string) => {
    setMessages((prev) => prev.map((item) => (item.id === id ? { ...item, content } : item)));
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setInput('');
    setError(null);
    setBusy(true);

    const userMessage: ChatMessage = { id: nextId(), role: 'user', content: text };
    const replyId = nextId();

    // 历史取发送前的快照：正在生成的空助手消息不应进入请求体
    const history = [...messages, userMessage].map(({ role, content }) => ({ role, content }));

    setMessages((prev) => [...prev, userMessage, { id: replyId, role: 'assistant', content: '' }]);

    const useStream = streamSupported();

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, stream: useStream }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message || `请求失败（HTTP ${response.status}）`);
      }

      if (!useStream || !response.body) {
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        patchMessage(replyId, body.choices?.[0]?.message?.content || '（上游未返回内容）');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const state = createSseState();
      let content = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        content += scanSse(state, decoder.decode(value, { stream: true }));
        patchMessage(replyId, content);
      }

      // 收尾：把解码器与缓冲区里的残留一并处理，否则末尾可能丢字
      content += scanSse(state, decoder.decode(), true);
      patchMessage(replyId, content || '（上游未返回内容）');
    } catch (caught) {
      const message = (caught as Error)?.message || '连接服务器失败';
      setError(message);
      patchMessage(replyId, `请求失败：${message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, input, messages, patchMessage]);

  const reset = useCallback(() => {
    setMessages([greetingMessage()]);
    setError(null);
  }, []);

  const applyPrompt = useCallback((text: string) => {
    setInput(text);
    inputRef.current?.focus();
  }, []);

  return (
    <section className="section" id="chat-test" aria-label="在线对话测试">
      <SectionHead
        kicker="Quick test"
        title="在线对话测试"
        desc="直接发送消息体验接口响应，也可以用快捷提示词快速开始。"
      />

      <div className="chat-card">
        <div className="chat-head">
          <div>
            <strong>免费 AI API 测试助手</strong>
            <span>输入一句话，确认当前服务是否可用。</span>
          </div>
          <Space>
            <Tag>{streamSupported() ? '流式' : '非流式降级'}</Tag>
            <Button size="small" onClick={reset} disabled={busy}>
              清空会话
            </Button>
          </Space>
        </div>

        <div className="chat-messages" ref={scrollRef} aria-live="polite">
          {messages.map((message) => (
            <motion.div
              key={message.id}
              className={`chat-message ${message.role}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {message.role === 'user' ? (
                message.content
              ) : message.content ? (
                <Markdown>{message.content}</Markdown>
              ) : (
                <span className="chat-typing">AI 正在思考…</span>
              )}
            </motion.div>
          ))}
        </div>

        <div className="chat-input-area">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder="输入消息，Enter 发送，Shift + Enter 换行…"
            aria-label="消息输入"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <Button type="primary" loading={busy} onClick={() => void send()}>
            发送
          </Button>
        </div>

        {error ? <div className="chat-error">{error}</div> : null}

        <div className="prompt-row">
          {QUICK_PROMPTS.map((prompt) => (
            <Button key={prompt.label} size="small" onClick={() => applyPrompt(prompt.text)}>
              {prompt.label}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}