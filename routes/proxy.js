const express = require('express');
const OpenAI = require('openai');
const { resolveProviders } = require('../lib/provider');
const { updateStats, addLog } = require('../lib/stats');

const router = express.Router();

// OpenAI client 缓存
const clientCache = new Map();

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

function pickModel(provider, requestedModel) {
  if (requestedModel) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.includes(requestedModel)) return requestedModel;
  }
  // 使用 provider 的第一个模型
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models[0] || requestedModel || 'gpt-3.5-turbo';
}

function formatSSE(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let actualModel = model;
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream) {
    // 提取真实模型
    if (chunk.model && chunk.model !== actualModel) {
      actualModel = chunk.model;
    } else if (!actualModel || actualModel === model) {
      if (chunk.model) actualModel = chunk.model;
    }

    // 提取 usage（最后一个 chunk 通常包含）
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens || 0;
      completionTokens = chunk.usage.completion_tokens || 0;
    }

    res.write(formatSSE(chunk));
  }

  res.write('data: [DONE]\n\n');
  res.end();

  // 统计
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
}

module.exports = router;