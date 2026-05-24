const express = require('express');
const OpenAI = require('openai');
const { Readable } = require('stream');
const { resolveProviders } = require('../lib/provider');
const { updateStats, addLog } = require('../lib/stats');

const router = express.Router();

// OpenAI client 缓存
const clientCache = new Map();
const modelRRCounters = new Map();
const MAX_MODEL_RETRY_COUNT = 3;
const MODEL_RESPONSE_TIMEOUT_MS = 5000;

function getClient(provider) {
  const key = `${provider.baseUrl}::${provider.apiKey}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new OpenAI({
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey,
    }));
  }
  return clientCache.get(key);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.connection.remoteAddress || 'unknown';
}

function normalizeModelRoutingRule(rule) {
  if (rule === 'random') return 'random';
  if (rule === 'average' || rule === 'balanced') return 'average';
  return 'priority';
}

function shuffleItems(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function rotateModelItems(provider, models) {
  if (models.length <= 1) return [...models];
  const key = `provider-model:${provider.id}:${models.join(',')}`;
  const current = modelRRCounters.get(key) || 0;
  modelRRCounters.set(key, current + 1);
  const offset = current % models.length;
  return [...models.slice(offset), ...models.slice(0, offset)];
}

function orderProviderModels(provider, models) {
  const rule = normalizeModelRoutingRule(provider.rule);
  if (rule === 'random') return shuffleItems(models);
  if (rule === 'average') return rotateModelItems(provider, models);
  return [...models];
}

function buildModelCandidates(provider, requestedModel) {
  const models = [...new Set((Array.isArray(provider.models) ? provider.models : []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (models.length === 0) {
    return [requestedModel || 'gpt-3.5-turbo'].filter(Boolean);
  }

  const orderedModels = orderProviderModels(provider, models);
  if (requestedModel && models.includes(requestedModel)) {
    return [requestedModel, ...orderedModels.filter((model) => model !== requestedModel)]
      .slice(0, MAX_MODEL_RETRY_COUNT);
  }

  return orderedModels.slice(0, MAX_MODEL_RETRY_COUNT);
}

function createTimeoutError(message) {
  const error = new Error(message);
  error.status = 408;
  error.code = 'MODEL_TIMEOUT';
  return error;
}

async function runWithTimeout(run, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw createTimeoutError(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readNextChunkWithTimeout(iterator, timeoutMs, timeoutMessage) {
  let timer = null;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createTimeoutError(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatSSE(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function setStreamHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders?.();
}

function writeSSE(res, data) {
  res.write(data);
  res.flush?.();
}

function extractRawStream(upstream) {
  const body = upstream?.controller?.response?.body;
  if (!body) return null;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (typeof body.on === 'function') return body;
  return null;
}

function parseSSEFrames(buffer, onFrame) {
  let cursor = 0;
  let boundary = buffer.indexOf('\n\n', cursor);
  while (boundary !== -1) {
    const frame = buffer.slice(cursor, boundary);
    onFrame(frame);
    cursor = boundary + 2;
    boundary = buffer.indexOf('\n\n', cursor);
  }
  return buffer.slice(cursor);
}

function readSSEData(frame) {
  return frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

function createRequestTrace() {
  const requestStartedAtMs = Date.now();
  return {
    requestStartedAtMs,
    requestStartedAt: new Date(requestStartedAtMs).toISOString(),
    firstResponseAtMs: null,
    firstResponseAt: null,
  };
}

function markFirstResponse(trace) {
  if (!trace || trace.firstResponseAtMs) return;
  trace.firstResponseAtMs = Date.now();
  trace.firstResponseAt = new Date(trace.firstResponseAtMs).toISOString();
}

function buildTimingFields(trace) {
  const completedAtMs = Date.now();
  return {
    requestStartedAt: trace?.requestStartedAt || null,
    firstResponseAt: trace?.firstResponseAt || null,
    completedAt: new Date(completedAtMs).toISOString(),
    firstResponseDurationMs: trace?.firstResponseAtMs ? trace.firstResponseAtMs - trace.requestStartedAtMs : null,
    totalDurationMs: trace?.requestStartedAtMs ? completedAtMs - trace.requestStartedAtMs : null,
  };
}

// POST /v1/chat/completions
router.post('/v1/chat/completions', async (req, res) => {
  const requestedModel = req.body.model || null;
  const stream = !!req.body.stream;
  const ip = getClientIp(req);
  const requestTrace = createRequestTrace();
  const providers = await resolveProviders(requestedModel);

  if (providers.length === 0) {
    return res.status(503).json({ error: { message: 'No available AI providers configured' } });
  }

  let lastError = null;
  let lastAttempt = null;

  for (const provider of providers) {
    const client = getClient(provider);
    const modelCandidates = buildModelCandidates(provider, requestedModel);

    for (const model of modelCandidates) {
      const payload = { ...req.body, model };
      lastAttempt = { provider, model, requestedModel: requestedModel || model };

      try {
        if (stream) {
          await handleStream(client, payload, provider, model, requestedModel || model, ip, req, res, requestTrace);
        } else {
          await handleNonStream(client, payload, provider, model, requestedModel || model, ip, req, res, requestTrace);
        }
        return;
      } catch (err) {
        lastError = err;
        const status = err.status || (err.response && err.response.status) || 'NO_STATUS';
        const message = err.message || 'Unknown error';
        console.warn(`[Proxy] ${provider.name} (${model}) failed: status=${status}, ${message}`);

        if (res.headersSent) {
          if (!res.writableEnded) {
            updateStats(provider.id, {
              requestedModel: requestedModel || model,
              actualModel: null,
              ip,
              promptTokens: 0,
              completionTokens: 0,
              success: false,
            }).catch(() => {});
            addLog({
              providerName: provider.name,
              requestedModel: requestedModel || model,
              actualModel: null,
              ip,
              promptTokens: 0,
              completionTokens: 0,
              success: false,
              error: message,
              ...buildTimingFields(requestTrace),
            });
            writeSSE(res, formatSSE({ error: { message } }));
            writeSSE(res, 'data: [DONE]\n\n');
            res.end();
          }
          return;
        }
      }
    }
  }

  // 所有 provider 都失败
  const status = lastError?.status || lastError?.response?.status || 500;
  const message = lastError?.message || 'All providers failed';
  if (lastAttempt) {
    updateStats(lastAttempt.provider.id, {
      requestedModel: lastAttempt.requestedModel,
      actualModel: null,
      ip,
      promptTokens: 0,
      completionTokens: 0,
      success: false,
    }).catch(() => {});
    addLog({
      providerName: lastAttempt.provider.name,
      requestedModel: lastAttempt.requestedModel,
      actualModel: null,
      ip,
      promptTokens: 0,
      completionTokens: 0,
      success: false,
      error: message,
      ...buildTimingFields(requestTrace),
    });
  }
  res.status(status).json({ error: { message, providerErrors: [] } });
});

async function handleNonStream(client, payload, provider, model, requestedModel, ip, req, res, requestTrace) {
  const response = await runWithTimeout(
    (signal) => client.chat.completions.create(payload, { signal }),
    MODEL_RESPONSE_TIMEOUT_MS,
    `Model ${model} timed out after ${MODEL_RESPONSE_TIMEOUT_MS}ms`,
  );

  markFirstResponse(requestTrace);
  const actualModel = response.model || model;
  const usage = response.usage || {};

  // 统计
  updateStats(provider.id, {
    requestedModel,
    actualModel,
    ip,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    success: true,
  }).catch(() => {});
  addLog({
    providerName: provider.name,
    requestedModel,
    actualModel,
    ip,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    success: true,
    ...buildTimingFields(requestTrace),
  });

  res.json(response);
}

async function handleStream(client, payload, provider, model, requestedModel, ip, req, res, requestTrace) {
  const streamPayload = { ...payload, stream: true, stream_options: { include_usage: true } };
  const stream = await runWithTimeout(
    (signal) => client.chat.completions.create(streamPayload, { signal }),
    MODEL_RESPONSE_TIMEOUT_MS,
    `Model ${model} timed out after ${MODEL_RESPONSE_TIMEOUT_MS}ms`,
  );

  let actualModel = model;
  let promptTokens = 0;
  let completionTokens = 0;
  let completed = false;
  let headersOpened = false;

  const ensureStreamStarted = () => {
    if (headersOpened) return;
    markFirstResponse(requestTrace);
    setStreamHeaders(res);
    headersOpened = true;
  };

  const recordSuccess = () => {
    updateStats(provider.id, {
      requestedModel,
      actualModel,
      ip,
      promptTokens,
      completionTokens,
      success: true,
    }).catch(() => {});
    addLog({
      providerName: provider.name,
      requestedModel,
      actualModel,
      ip,
      promptTokens,
      completionTokens,
      success: true,
      ...buildTimingFields(requestTrace),
    });
  };

  const rawStream = extractRawStream(stream);
  if (rawStream) {
    const iterator = rawStream[Symbol.asyncIterator]();
    let buffer = '';

    while (true) {
      const { value, done } = await readNextChunkWithTimeout(
        iterator,
        MODEL_RESPONSE_TIMEOUT_MS,
        `Model ${model} timed out after ${MODEL_RESPONSE_TIMEOUT_MS}ms`,
      );
      if (done) break;

      ensureStreamStarted();
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      writeSSE(res, text);

      buffer = parseSSEFrames(buffer + text.replace(/\r\n/g, '\n'), (frame) => {
        const data = readSSEData(frame);
        if (!data || data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.model) actualModel = parsed.model;
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens || 0;
            completionTokens = parsed.usage.completion_tokens || 0;
          }
        } catch (error) {
          // 上游偶发非 JSON 事件不影响流式透传
        }
      });
    }

    completed = true;
  } else {
    const iterator = stream[Symbol.asyncIterator]();

    while (true) {
      const { value: chunk, done } = await readNextChunkWithTimeout(
        iterator,
        MODEL_RESPONSE_TIMEOUT_MS,
        `Model ${model} timed out after ${MODEL_RESPONSE_TIMEOUT_MS}ms`,
      );
      if (done) break;

      ensureStreamStarted();
      if (chunk.model) actualModel = chunk.model;
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || 0;
        completionTokens = chunk.usage.completion_tokens || 0;
      }

      writeSSE(res, formatSSE(chunk));
    }

    if (headersOpened) {
      writeSSE(res, 'data: [DONE]\n\n');
    }
    completed = true;
  }

  if (headersOpened && !res.writableEnded) res.end();
  if (completed) recordSuccess();
}

module.exports = router;