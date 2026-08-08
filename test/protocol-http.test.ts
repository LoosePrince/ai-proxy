import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express, { type Express } from 'express';
import type OpenAI from 'openai';

import { createResponseGate } from '../src/core/gate';
import { createResponseEnvelope } from '../src/core/protocol';
import { readChunkWithTimeout, withTimeout } from '../src/core/timeout';
import { PROXY_ROUTES, registerProxyRoutes } from '../src/http/proxy-routes';
import { invokeUpstream, writeStreamError } from '../src/upstream/invoke';

async function withServer<T>(app: Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const { port } = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function fakeClient(result: unknown): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => result,
      },
    },
  } as unknown as OpenAI;
}

function parseResponseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe('HTTP 协议入口', () => {
  it('同时注册 chat/responses 的带 /v1 与无 /v1 入口', async () => {
    assert.deepEqual(
      PROXY_ROUTES.map(({ path, protocol }) => [path, protocol]),
      [
        ['/v1/chat/completions', 'chat'],
        ['/chat/completions', 'chat'],
        ['/v1/responses', 'responses'],
        ['/responses', 'responses'],
      ],
    );

    const app = express();
    app.use(express.json());
    registerProxyRoutes(app, (req, res, protocol) => {
      res.json({ path: req.path, protocol, model: req.body?.model });
    });

    await withServer(app, async (baseUrl) => {
      for (const { path, protocol } of PROXY_ROUTES) {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test-model' }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { path, protocol, model: 'test-model' });
      }
    });
  });
});

describe('Responses 非流式格式', () => {
  it('输出模型、思考、工具调用和完整 usage', () => {
    const response = createResponseEnvelope({
      request: { reasoning: { effort: 'high' }, max_output_tokens: 128 },
      id: 'chatcmpl-test',
      model: 'deepseek-reasoner',
      content: '最终答案',
      reasoningContent: '思考过程',
      toolCalls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } },
      ],
      promptTokens: 12,
      completionTokens: 8,
      reasoningTokens: 5,
    });

    assert.equal(response.id, 'resp_test');
    assert.equal(response.object, 'response');
    assert.equal(response.model, 'deepseek-reasoner');
    assert.equal(response.output_text, '最终答案');
    assert.deepEqual(response.usage, {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 20,
    });
    assert.deepEqual(
      (response.output as Array<Record<string, unknown>>).map((item) => item.type),
      ['reasoning', 'message', 'function_call'],
    );
  });

  it('通过真实 HTTP 响应返回 Responses envelope', async () => {
    const app = express();
    app.use(express.json());
    app.post('/responses', (req, res) => {
      void invokeUpstream(
        {
          client: fakeClient({
            id: 'chatcmpl-http',
            created: 1_700_000_000,
            model: 'provider/model-real',
            choices: [{ message: { content: '完成', reasoning_content: '先分析' } }],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 6,
              completion_tokens_details: { reasoning_tokens: 3 },
            },
          }),
          payload: req.body,
          responseRequest: req.body,
          protocol: 'responses',
          model: 'model-requested',
          res,
          gate: createResponseGate(),
          owner: 'test',
          timeoutMs: 1_000,
        },
        false,
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '你好', reasoning: { effort: 'high' } }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 200);
      assert.equal(body.id, 'resp_http');
      assert.equal(body.model, 'provider/model-real');
      assert.equal(body.output_text, '完成');
      assert.deepEqual(
        (body.output as Array<Record<string, unknown>>).map((item) => item.type),
        ['reasoning', 'message'],
      );
    });
  });
});

describe('Responses 流式格式', () => {
  it('转换 reasoning、文本、模型和 usage，并保持 sequence_number 单调递增', async () => {
    async function* chunks() {
      yield {
        model: 'provider/deepseek-reasoner',
        choices: [{ delta: { reasoning_content: '分析' } }],
      };
      yield { choices: [{ delta: { content: '答案' } }] };
      yield {
        choices: [],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 9,
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      };
    }

    const app = express();
    app.post('/stream', (_req, res) => {
      void invokeUpstream(
        {
          client: fakeClient(chunks()),
          payload: {},
          responseRequest: { reasoning: { effort: 'high' } },
          protocol: 'responses',
          model: 'requested-model',
          res,
          gate: createResponseGate(),
          owner: 'stream-test',
          timeoutMs: 1_000,
        },
        true,
      );
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/stream`, { method: 'POST' });
      const events = parseResponseEvents(await response.text());
      const types = events.map((event) => event.type);
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(types[0], 'response.created');
      assert.ok(types.includes('response.reasoning.delta'));
      assert.ok(types.includes('response.output_text.delta'));
      assert.equal(types.at(-1), 'response.completed');
      assert.deepEqual(
        events.map((event) => event.sequence_number),
        events.map((_, index) => index),
      );

      const completed = events.at(-1)?.response as Record<string, unknown>;
      assert.equal(completed.model, 'provider/deepseek-reasoner');
      assert.equal(completed.output_text, '答案');
      assert.deepEqual(completed.usage, {
        input_tokens: 7,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 9,
        output_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 16,
      });
    });
  });

  it('已开流错误使用 response.failed 事件收尾', async () => {
    const app = express();
    app.post('/failed', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.flushHeaders();
      writeStreamError(res, 'upstream failed', 'responses');
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/failed`, { method: 'POST' });
      const events = parseResponseEvents(await response.text());
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, 'response.failed');
      assert.deepEqual((events[0]?.response as Record<string, unknown>).error, {
        code: 'upstream_error',
        message: 'upstream failed',
      });
    });
  });
});

describe('客户端断连信号', () => {
  it('中止建连阶段和流读取，不等待服务端超时', async () => {
    const first = new AbortController();
    const firstReason = new Error('client disconnected');
    const connecting = withTimeout(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      10_000,
      'timeout',
      first.signal,
    );
    first.abort(firstReason);
    await assert.rejects(connecting, (error: unknown) => error === firstReason);

    const second = new AbortController();
    const secondReason = new Error('stream disconnected');
    const reading = readChunkWithTimeout(
      { next: () => new Promise<IteratorResult<string>>(() => undefined) },
      10_000,
      'stalled',
      second.signal,
    );
    second.abort(secondReason);
    await assert.rejects(reading, (error: unknown) => error === secondReason);
  });
});