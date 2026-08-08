/**
 * Chat Completions 与 Responses 的协议归一化。
 *
 * 这里仅处理无 IO 的数据变换：HTTP 层决定入口协议，上游层决定如何调用。
 * DeepSeek 的 reasoning_content 必须和对应 assistant 消息一起回传，不能拆成
 * 独立上下文消息，否则思考模式的下一轮请求会被上游拒绝。
 */

import { randomUUID } from 'node:crypto';

export type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textFromPart(part: unknown): string | null {
  if (!isRecord(part)) return null;
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return null;
}

function reasoningFromPart(part: unknown): string | null {
  if (!isRecord(part)) return null;
  if (!['reasoning', 'thinking', 'reasoning_text', 'summary_text'].includes(String(part.type ?? ''))) {
    return null;
  }
  return textFromPart(part);
}

function normalizeAssistantMessage(message: JsonRecord): JsonRecord {
  const next = { ...message };
  let reasoning =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : typeof message.thinking === 'string'
          ? message.thinking
          : null;

  if (Array.isArray(message.content)) {
    const reasoningParts = message.content.map(reasoningFromPart).filter((text): text is string => !!text);
    if (!reasoning && reasoningParts.length > 0) reasoning = reasoningParts.join('');

    if (reasoningParts.length > 0) {
      const visibleParts = message.content.filter((part) => reasoningFromPart(part) === null);
      const visibleText = visibleParts.map(textFromPart);
      next.content = visibleText.every((text) => text !== null)
        ? visibleText.filter((text): text is string => text !== null).join('')
        : visibleParts;
    }
  }

  if (reasoning) next.reasoning_content = reasoning;
  delete next.reasoning;
  if (typeof next.thinking === 'string') delete next.thinking;
  return next;
}

/** 保留未知参数，仅统一 assistant 历史中的思考字段。 */
export function normalizeChatPayload(payload: JsonRecord): JsonRecord {
  if (!Array.isArray(payload.messages)) return { ...payload };

  return {
    ...payload,
    messages: payload.messages.map((message) =>
      isRecord(message) && message.role === 'assistant' ? normalizeAssistantMessage(message) : message,
    ),
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (['input_text', 'output_text', 'text'].includes(String(part.type ?? ''))) return textFromPart(part) ?? '';
      return '';
    })
    .join('');
}

function reasoningItemText(item: JsonRecord): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const content = Array.isArray(item.content) ? item.content : [];
  return [...summary, ...content].map(textFromPart).filter((text): text is string => !!text).join('');
}

/**
 * Responses input 转成 Chat messages。reasoning item 会合并进随后的 assistant
 * message，以满足 DeepSeek 对 reasoning_content + content 成对回传的约束。
 */
export function responseInputToChatMessages(input: unknown, instructions?: unknown): JsonRecord[] {
  const messages: JsonRecord[] = [];
  if (typeof instructions === 'string' && instructions) {
    messages.push({ role: 'developer', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  let pendingReasoning = '';
  for (const item of input) {
    if (!isRecord(item)) continue;

    if (item.type === 'reasoning') {
      pendingReasoning += reasoningItemText(item);
      continue;
    }

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? ''),
        content: contentToText(item.output),
      });
      continue;
    }

    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: String(item.call_id ?? item.id ?? ''),
            type: 'function',
            function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '') },
          },
        ],
      });
      continue;
    }

    if (typeof item.role !== 'string') continue;
    const message: JsonRecord = { role: item.role, content: contentToText(item.content) };
    if (item.role === 'assistant' && pendingReasoning) {
      message.reasoning_content = pendingReasoning;
      pendingReasoning = '';
    }
    messages.push(message);
  }

  if (pendingReasoning) messages.push({ role: 'assistant', content: null, reasoning_content: pendingReasoning });
  return messages;
}

function responsesToolsToChat(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== 'function') return tool;
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      },
    };
  });
}

/** Responses 创建参数转换为 Chat Completions 参数。 */
export function responsesPayloadToChat(payload: JsonRecord): JsonRecord {
  const chat: JsonRecord = {
    model: payload.model,
    messages: responseInputToChatMessages(payload.input, payload.instructions),
    stream: payload.stream === true,
  };

  const directKeys = ['temperature', 'top_p', 'metadata', 'parallel_tool_calls', 'user'];
  for (const key of directKeys) {
    if (payload[key] !== undefined) chat[key] = payload[key];
  }

  if (payload.max_output_tokens !== undefined) chat.max_completion_tokens = payload.max_output_tokens;
  if (payload.tools !== undefined) chat.tools = responsesToolsToChat(payload.tools);
  if (payload.tool_choice !== undefined) chat.tool_choice = payload.tool_choice;

  if (isRecord(payload.text) && payload.text.format !== undefined) {
    chat.response_format = payload.text.format;
  }

  if (isRecord(payload.reasoning)) {
    if (typeof payload.reasoning.effort === 'string') chat.reasoning_effort = payload.reasoning.effort;
    chat.thinking = { type: 'enabled' };
  }

  return normalizeChatPayload(chat);
}

export interface ResponseEnvelopeOptions {
  request: JsonRecord;
  model: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: Array<JsonRecord>;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  id?: string;
  createdAt?: number;
}

/** Chat completion 结果物化为 Responses 非流式格式。 */
export function createResponseEnvelope(options: ResponseEnvelopeOptions): JsonRecord {
  const id = options.id?.replace(/^chatcmpl-/, 'resp_') ?? `resp_${randomUUID().replace(/-/g, '')}`;
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const output: JsonRecord[] = [];

  if (options.reasoningContent) {
    output.push({
      id: `rs_${id.slice(5)}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: options.reasoningContent }],
      status: 'completed',
    });
  }

  if (options.content || !options.toolCalls?.length) {
    output.push({
      id: `msg_${id.slice(5)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: options.content, annotations: [] }],
    });
  }

  for (const toolCall of options.toolCalls ?? []) {
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    output.push({
      id: String(toolCall.id ?? `fc_${randomUUID().replace(/-/g, '')}`),
      type: 'function_call',
      status: 'completed',
      call_id: String(toolCall.id ?? ''),
      name: String(fn.name ?? ''),
      arguments: String(fn.arguments ?? ''),
    });
  }

  const inputTokens = options.promptTokens ?? 0;
  const outputTokens = options.completionTokens ?? 0;
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: typeof options.request.instructions === 'string' ? options.request.instructions : null,
    max_output_tokens: options.request.max_output_tokens ?? null,
    model: options.model,
    output,
    output_text: options.content,
    parallel_tool_calls: options.request.parallel_tool_calls !== false,
    previous_response_id: null,
    reasoning: options.request.reasoning ?? null,
    store: options.request.store === true,
    temperature: options.request.temperature ?? null,
    text: options.request.text ?? { format: { type: 'text' } },
    tool_choice: options.request.tool_choice ?? 'auto',
    tools: options.request.tools ?? [],
    top_p: options.request.top_p ?? null,
    truncation: options.request.truncation ?? 'disabled',
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: options.reasoningTokens ?? 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };
}