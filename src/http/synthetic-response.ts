import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

import { createResponseEnvelope, type JsonRecord } from '../core/protocol';
import type { ProxyProtocol } from './proxy-routes';

export interface SyntheticResponseResult {
  contentType: string;
  body: string;
  responseBody: unknown;
}

function chatCompletion(model: string, content: string, id: string, created: number): JsonRecord {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sse(event: JsonRecord, type?: string): string {
  return `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
}

function chatStream(model: string, content: string, id: string, created: number): string {
  const chunks = [
    sse({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
  ];
  if (content) {
    chunks.push(
      sse({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      }),
    );
  }
  chunks.push(
    sse({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
    'data: [DONE]\n\n',
  );
  return chunks.join('');
}

function responsesStream(request: JsonRecord, model: string, content: string, id: string, created: number): string {
  const responseId = id.replace(/^chatcmpl-/, 'resp_');
  const messageId = `msg_${responseId.slice(5)}`;
  const envelope = createResponseEnvelope({ request, model, content, id: responseId, createdAt: created });
  const message = (envelope.output as JsonRecord[])[0];
  const events: JsonRecord[] = [
    { type: 'response.created', response: { ...envelope, status: 'in_progress', output: [] } },
    { type: 'response.in_progress', response: { ...envelope, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  ];
  if (content) {
    events.push({
      type: 'response.output_text.delta',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: content,
      logprobs: [],
    });
  }
  events.push(
    {
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: content,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: content, annotations: [] },
    },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: envelope },
  );
  return events.map((event, sequence) => sse({ ...event, sequence_number: sequence }, String(event.type))).join('');
}

export function writeSyntheticSuccess(
  res: Response,
  protocol: ProxyProtocol,
  request: JsonRecord,
  model: string,
  stream: boolean,
  content: string,
): SyntheticResponseResult {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const created = Math.floor(Date.now() / 1000);
  const responseBody =
    protocol === 'responses'
      ? createResponseEnvelope({ request, model, content, id, createdAt: created })
      : chatCompletion(model, content, id, created);

  if (!stream) {
    const body = JSON.stringify(responseBody);
    res.status(200).type('application/json').send(body);
    return { contentType: 'application/json; charset=utf-8', body, responseBody };
  }

  const body =
    protocol === 'responses'
      ? responsesStream(request, model, content, id, created)
      : chatStream(model, content, id, created);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.end(body);
  return { contentType: 'text/event-stream; charset=utf-8', body, responseBody };
}