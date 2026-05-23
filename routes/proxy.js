const express = require('express');
const OpenAI = require('openai');
const { Readable } = require('stream');
const { resolveProviders } = require('../lib/provider');
const { updateStats, addLog } = require('../lib/stats');

const router = express.Router();

// OpenAI client 缓存
const clientCache = new Map();
const modelRRCounters = new Map();

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

function pickFallbackModel(provider, models) {
  if (models.length === 0) return null;

  const rule = normalizeModelRoutingRule(provider.rule);
  if (rule === 'random') {
    return models[Math.floor(Math.random() * models.length)];
  }

  if (rule === 'average') {
    const key = `provider-model:${provider.id}:${models.join(',')}`;
    const current = modelRRCounters.get(key) || 0;
    modelRRCounters.set(key, current + 1);
    return models[current % models.length];
  }

  return models[0];
}

function pickModel(provider, requestedModel) {
  const models = Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  if (requestedModel && models.includes(requestedModel)) {
    return requestedModel;
  }

  return pickFallbackModel(provider, models) || requestedModel || 'gpt-3.5-turbo';
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

// POST /v1/chat/completions
router.post('/v1/chat/completions', async (req, res) => {
  const requestedModel = req.body.model || null;
  const stream = !!req.body.stream;
  const ip = getClientIp(req);
  const providers = await resolveProviders(requestedModel);

  if (providers.length === 0) {
    return res.status(503).json({ error: { message: 'No available AI providers configured' } });
  }

  let lastError = null;

  for (const provider of providers) {
    const model = pickModel(provider, requestedModel);
    const payload = { ...req.body, model };

    try {
      const client = getClient(provider);

      if (stream) {
        await handleStream(client, payload, provider, model, requestedModel || model, ip, req, res);
      } else {
        await handleNonStream(client, payload, provider, model, requestedModel || model, ip, req, res);
      }
      return; // 成功，结束
    } catch (err) {
      lastError = err;
      const status = err.status || (err.response && err.response.status) || 'NO_STATUS';
      const message = err.message || 'Unknown error';
      console.warn(`[Proxy] ${provider.name} (${model}) failed: status=${status}, ${message}`);

      if (res.headersSent) {
        if (!res.writableEnded) {
          writeSSE(res, formatSSE({ error: { message } }));
          writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      // 记录失败
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
      });
    }
  }

  // 所有 provider 都失败
  const status = lastError?.status || lastError?.response?.status || 500;
  const message = lastError?.message || 'All providers failed';
  res.status(status).json({ error: { message, providerErrors: [] } });
});

async function handleNonStream(client, payload, provider, model, requestedModel, ip, req, res) {
  const response = await client.chat.completions.create(payload);

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
  });

  res.json(response);
}

async function handleStream(client, payload, provider, model, requestedModel, ip, req, res) {
  const streamPayload = { ...payload, stream: true, stream_options: { include_usage: true } };
  const stream = await client.chat.completions.create(streamPayload);

  setStreamHeaders(res);

  let actualModel = model;
  let promptTokens = 0;
  let completionTokens = 0;
  let completed = false;

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
    });
  };

  const rawStream = extractRawStream(stream);
  if (rawStream) {
    let buffer = '';

    for await (const chunk of rawStream) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
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
    for await (const chunk of stream) {
      if (chunk.model) actualModel = chunk.model;
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || 0;
        completionTokens = chunk.usage.completion_tokens || 0;
      }

      writeSSE(res, formatSSE(chunk));
    }

    writeSSE(res, 'data: [DONE]\n\n');
    completed = true;
  }

  if (!res.writableEnded) res.end();
  if (completed) recordSuccess();
}

module.exports = router;