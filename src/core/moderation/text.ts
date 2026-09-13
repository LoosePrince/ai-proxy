/**
 * 审核文本抽取 —— 从请求体 / 响应体 / SSE 帧里取出「需要审核的文本」。
 *
 * 请求侧只取**用户可控**内容（role 非 system/developer），理由与旧版
 * request-policy 一致：系统提示词里讨论安全策略不应被判为违规。
 * 响应侧取模型产出的正文与思考内容。
 *
 * 纯函数，无 IO。所有输出都受 maxChars 上限约束，避免超长上下文放大 CPU。
 */

import type { JsonRecord } from '../protocol';

export const DEFAULT_SCAN_CHARS = 40_000;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 递归收集字符串，去重对象引用以避免循环结构，并遵守总量上限 */
export function collectStrings(value: unknown, maxChars = DEFAULT_SCAN_CHARS): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const total = { value: 0 };

  const walk = (node: unknown): void => {
    if (total.value >= maxChars) return;
    if (typeof node === 'string') {
      const slice = node.slice(0, maxChars - total.value);
      if (slice) parts.push(slice);
      total.value += slice.length;
      return;
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const item of Object.values(node as JsonRecord)) walk(item);
  };

  walk(value);
  return parts.join('\n');
}

/** 单条 message 的正文：兼容 content 字符串、内容块数组与工具调用参数 */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!isRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return collectStrings(content);
  return '';
}

/** 请求侧待审文本：只包含用户可控角色的消息与常见输入字段 */
export function payloadUserText(payload: JsonRecord, maxChars = DEFAULT_SCAN_CHARS): string {
  const parts: string[] = [];

  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (isRecord(message) && (message.role === 'system' || message.role === 'developer')) continue;
      const text = messageText(message);
      if (text) parts.push(text);
    }
  }

  for (const key of ['input', 'prompt', 'query', 'content']) {
    const value = payload[key];
    if (typeof value === 'string') parts.push(value);
    else if (value !== undefined && value !== null && typeof value === 'object') parts.push(collectStrings(value));
  }

  return parts.join('\n').slice(0, maxChars);
}

/** 非流式响应侧待审文本：模型正文 + 思考内容 + 工具调用参数 */
export function responseText(body: unknown, maxChars = DEFAULT_SCAN_CHARS): string {
  if (typeof body === 'string') return body.slice(0, maxChars);
  if (!isRecord(body)) return '';

  const parts: string[] = [];

  // Chat Completions 形态
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!isRecord(choice)) continue;
      const message = isRecord(choice.message) ? choice.message : {};
      for (const key of ['content', 'reasoning_content', 'reasoning']) {
        const value = message[key];
        if (typeof value === 'string' && value) parts.push(value);
      }
      if (message.tool_calls !== undefined) parts.push(collectStrings(message.tool_calls));
      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content) parts.push(delta.content);
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          parts.push(delta.reasoning_content);
        }
      }
    }
  }

  // Responses 形态：output[].content[].text 与 output_text
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item)) continue;
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isRecord(part)) continue;
          if (typeof part.text === 'string') parts.push(part.text);
        }
      }
      if (typeof item.text === 'string') parts.push(item.text);
      if (item.arguments !== undefined) parts.push(collectStrings(item.arguments));
    }
  }
  if (typeof body.output_text === 'string') parts.push(body.output_text);
  if (typeof body.delta === 'string') parts.push(body.delta);

  return parts.join('\n').slice(0, maxChars);
}

/** SSE 原始帧文本 → 该帧携带的增量正文（chat delta / responses delta / output_text.delta） */
export function sseFrameText(frame: string): string {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return '';
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') return '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return '';
  }

  return responseText(parsed);
}

/**
 * 增量 SSE 文本 → 拆出完整帧（以空行结尾）与残留 buffer。
 * 与 upstream/sse.ts 的 scanText 同思路，但这里只关心正文，不关心 usage。
 */
export function splitSseFrames(buffer: string, incoming: string): { frames: string[]; rest: string } {
  const merged = buffer + incoming.replace(/\r\n/g, '\n');
  const frames: string[] = [];
  let cursor = 0;
  let boundary = merged.indexOf('\n\n', cursor);

  while (boundary !== -1) {
    frames.push(merged.slice(cursor, boundary));
    cursor = boundary + 2;
    boundary = merged.indexOf('\n\n', cursor);
  }

  return { frames, rest: merged.slice(cursor) };
}
