const express = require('express');
const OpenAI = require('openai');
const { Readable } = require('stream');
const {
  resolveGlobalModelProviders,
  resolveProviders,
} = require('../lib/provider');
const { updateStats, addLog } = require('../lib/stats');

const router = express.Router();

// OpenAI client 缓存
const clientCache = new Map();
const modelRRCounters = new Map();
const MAX_MODEL_RETRY_COUNT = 3;
const DEFAULT_MODEL_RESPONSE_TIMEOUT_MS = 30_000;
const PARALLEL_PROVIDER_TIMEOUT_MS = 14_000;

function normalizePositiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

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

function createResponseGate() {
  let claimed = false;
  let owner = null;
  return {
    claim(nextOwner, canClaim = () => true) {
      if (claimed || !canClaim()) return false;
      claimed = true;
      owner = nextOwner || null;
      return true;
    },
    isClaimed() {
      return claimed;
    },
    isOwnedBy(nextOwner) {
      return claimed && owner === nextOwner;
    },
  };
}

function createResponseClaimError() {
  const error = new Error('Response already claimed by another provider');
  error.code = 'RESPONSE_CLAIMED';
  error.status = 409;
  return error;
}

function createRouteTraceEntry({ provider, model, requestedModel, actualModel, role, timeoutMs, status, error, startedAtMs }) {
  const completedAtMs = Date.now();
  return {
    role: role || provider.specialRole || 'primary',
    providerName: provider.name,
    providerId: provider.id,
    priority: provider.priority,
    requestedModel: requestedModel || model,
    actualModel: status === 'success' ? (actualModel || model) : null,
    attemptedModel: model,
    timeoutMs,
    status,
    error: error ? (error.message || String(error)) : null,
    startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: startedAtMs ? completedAtMs - startedAtMs : null,
  };
}

function summarizeProvider(provider, role) {
  if (!provider) return null;
  return {
    role: role || provider.specialRole || 'primary',
    providerName: provider.name,
    providerId: provider.id,
    priority: provider.priority,
    models: Array.isArray(provider.models) ? provider.models : [],
  };
}

function createRouteTrace({ requestedModel, primaryProviders, parallelProvider, fallbackProvider, config }) {
  return {
    requestedModel: requestedModel || null,
    config: {
      defaultResponseTimeoutMs: config.defaultResponseTimeoutMs,
      fallbackResponseTimeoutMs: config.fallbackResponseTimeoutMs,
      parallelTimeoutMs: config.parallelTimeoutMs,
      priorityTimeouts: config.priorityTimeouts || {},
    },
    plannedChain: {
      primary: primaryProviders.map((provider) => summarizeProvider(provider, 'primary')),
      parallel: summarizeProvider(parallelProvider, 'parallel'),
      fallback: summarizeProvider(fallbackProvider, 'fallback'),
    },
    attempts: [],
    finalProviderName: null,
    finalProviderRole: null,
    finalModel: null,
    fallbackTriggered: false,
  };
}

function getProviderTimeoutMs(provider, config) {
  if (provider?.specialRole === 'fallback') {
    return normalizePositiveMs(config.fallbackResponseTimeoutMs, config.defaultResponseTimeoutMs || DEFAULT_MODEL_RESPONSE_TIMEOUT_MS);
  }
  if (provider?.specialRole === 'parallel') {
    return normalizePositiveMs(config.parallelTimeoutMs, PARALLEL_PROVIDER_TIMEOUT_MS);
  }
  const priorityKey = String(Number(provider?.priority ?? 0));
  return normalizePositiveMs(
    config.priorityTimeouts?.[priorityKey],
    config.defaultResponseTimeoutMs || DEFAULT_MODEL_RESPONSE_TIMEOUT_MS,
  );
}

function completeRouteTrace(routeTrace, result, role) {
  if (!routeTrace || !result?.ok) return;
  routeTrace.finalProviderName = result.provider?.name || null;
  routeTrace.finalProviderRole = role || result.provider?.specialRole || 'primary';
  routeTrace.finalModel = result.model || null;
}

function cloneRouteTrace(routeTrace) {
  if (!routeTrace) return null;
  return JSON.parse(JSON.stringify(routeTrace));
}

function createLogEntry(base, routeTrace) {
  const traceRef = routeTrace || null;
  return {
    ...base,
    finalProviderName: traceRef?.finalProviderName || base.providerName || null,
    finalProviderRole: traceRef?.finalProviderRole || null,
    finalModel: traceRef?.finalModel || base.actualModel || null,
    fallbackTriggered: !!traceRef?.fallbackTriggered,
    routeTrace: traceRef,
  };
}

function claimResponse(responseGate, res, owner, canClaimResponse) {
  if (res.headersSent || res.writableEnded) return false;
  if (!responseGate) return true;
  return responseGate.claim(owner, canClaimResponse);
}

function canWriteClaimedResponse(responseGate, owner) {
  if (!responseGate) return true;
  return responseGate.isOwnedBy(owner);
}

function createTimeoutResult(label, timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        ok: false,
        label,
        error: createTimeoutError(`${label} timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
  });
}

function updateProviderStats(provider, fields) {
  if (provider.id > 0) return updateStats(provider.id, fields);
  if (provider.isSpecialProvider) return updateStats(provider, fields);
  return Promise.resolve();
}

async function attemptProvider({ provider, requestedModel, stream, ip, req, res, requestTrace, responseGate, responseOwner, canClaimResponse, timeoutMs, routeTrace, role }) {
  const client = getClient(provider);
  const modelCandidates = buildModelCandidates(provider, requestedModel);
  let lastError = null;
  let lastAttempt = null;

  for (const model of modelCandidates) {
    const payload = { ...req.body, model };
    const startedAtMs = Date.now();
    lastAttempt = { provider, model, requestedModel: requestedModel || model };

    try {
      let resultMeta = null;
      if (stream) {
        resultMeta = await handleStream(client, payload, provider, model, requestedModel || model, ip, req, res, requestTrace, responseGate, responseOwner, canClaimResponse, timeoutMs, routeTrace);
      } else {
        resultMeta = await handleNonStream(client, payload, provider, model, requestedModel || model, ip, req, res, requestTrace, responseGate, responseOwner, canClaimResponse, timeoutMs, routeTrace);
      }
      const actualModel = resultMeta?.actualModel || model;
      const promptTokens = resultMeta?.promptTokens || 0;
      const completionTokens = resultMeta?.completionTokens || 0;
      const successResult = { ok: true, provider, model: actualModel, requestedModel: requestedModel || model };
      routeTrace?.attempts.push(createRouteTraceEntry({
        provider,
        model,
        requestedModel: requestedModel || model,
        actualModel,
        role,
        timeoutMs,
        status: 'success',
        startedAtMs,
      }));
      completeRouteTrace(routeTrace, successResult, role);
      addLog(createLogEntry({
        providerName: provider.name,
        requestedModel: requestedModel || model,
        actualModel,
        ip,
        promptTokens,
        completionTokens,
        success: true,
        ...buildTimingFields(requestTrace),
      }, routeTrace));
      return successResult;
    } catch (err) {
      lastError = err;
      if (err?.code === 'RESPONSE_CLAIMED') {
        routeTrace?.attempts.push(createRouteTraceEntry({
          provider,
          model,
          requestedModel: requestedModel || model,
          role,
          timeoutMs,
          status: 'claimed-by-other',
          error: err,
          startedAtMs,
        }));
        return { ok: false, provider, error: err, attempt: lastAttempt, responseEnded: res.headersSent || res.writableEnded };
      }
      const status = err.status || (err.response && err.response.status) || 'NO_STATUS';
      const message = err.message || 'Unknown error';
      routeTrace?.attempts.push(createRouteTraceEntry({
        provider,
        model,
        requestedModel: requestedModel || model,
        role,
        timeoutMs,
        status: 'failed',
        error: err,
        startedAtMs,
      }));
      console.warn(`[Proxy] ${provider.name} (${model}) failed: status=${status}, timeoutMs=${timeoutMs}, ${message}`);

      if (res.headersSent) {
        if (!res.writableEnded && canWriteClaimedResponse(responseGate, responseOwner)) {
          updateProviderStats(provider, {
            requestedModel: requestedModel || model,
            actualModel: null,
            ip,
            promptTokens: 0,
            completionTokens: 0,
            success: false,
          }).catch(() => {});
          addLog(createLogEntry({
            providerName: provider.name,
            requestedModel: requestedModel || model,
            actualModel: null,
            ip,
            promptTokens: 0,
            completionTokens: 0,
            success: false,
            error: message,
            ...buildTimingFields(requestTrace),
          }, routeTrace));
          writeSSE(res, formatSSE({ error: { message } }));
          writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
        return { ok: false, provider, error: err, attempt: lastAttempt, responseEnded: true };
      }
    }
  }

  return { ok: false, provider, error: lastError, attempt: lastAttempt };
}

// POST /v1/chat/completions
router.post('/v1/chat/completions', async (req, res) => {
  const requestedModel = req.body.model || null;
  const stream = !!req.body.stream;
  const ip = getClientIp(req);
  const requestTrace = createRequestTrace();
  const [providers, globalModelProviders] = await Promise.all([
    resolveProviders(requestedModel),
    resolveGlobalModelProviders(requestedModel),
  ]);

  if (providers.length === 0 && !globalModelProviders.fallbackProvider && !globalModelProviders.parallelProvider) {
    return res.status(503).json({ error: { message: 'No available AI providers configured' } });
  }

  let lastError = null;
  let lastAttempt = null;
  const responseGate = createResponseGate();
  const maxPrimaryAttempts = MAX_MODEL_RETRY_COUNT;
  const primaryProviders = providers.slice(0, maxPrimaryAttempts);

  const parallelProvider = globalModelProviders.parallelProvider;
  const fallbackProvider = globalModelProviders.fallbackProvider;
  const routeTrace = createRouteTrace({
    requestedModel,
    primaryProviders,
    parallelProvider,
    fallbackProvider,
    config: globalModelProviders.config,
  });
  const shouldRaceParallel = !!parallelProvider && primaryProviders.length > 0;

  const runAttempt = async (provider, canClaimResponse = () => true, responseOwner = provider, role = provider?.specialRole || 'primary') => {
    const timeoutMs = getProviderTimeoutMs(provider, globalModelProviders.config);
    const result = await attemptProvider({
      provider,
      requestedModel,
      stream,
      ip,
      req,
      res,
      requestTrace,
      responseGate,
      responseOwner,
      canClaimResponse,
      timeoutMs,
      routeTrace,
      role,
    });
    if (!result.ok) {
      lastError = result.error || lastError;
      lastAttempt = result.attempt || lastAttempt;
    }
    return result;
  };

  if (stream) {
    if (shouldRaceParallel) {
      const raceStartedAt = Date.now();
      const canClaimParallelResponse = () => Date.now() - raceStartedAt <= (globalModelProviders.config.parallelTimeoutMs || PARALLEL_PROVIDER_TIMEOUT_MS);
      runAttempt(parallelProvider, canClaimParallelResponse, parallelProvider, 'parallel')
        .then((result) => {
          if (!result.ok && !res.headersSent) {
            lastError = result.error || lastError;
            lastAttempt = result.attempt || lastAttempt;
          }
        })
        .catch((error) => {
          if (!res.headersSent) lastError = error;
        });
    }

    for (const provider of primaryProviders) {
      if (res.headersSent || res.writableEnded) return;
      const result = await runAttempt(provider);
      if (result.ok || (result.responseEnded && res.headersSent)) return;
    }
  } else if (shouldRaceParallel) {
    const parallelTimeoutMs = globalModelProviders.config.parallelTimeoutMs || PARALLEL_PROVIDER_TIMEOUT_MS;
    const raceStartedAt = Date.now();
    const canClaimParallelResponse = () => Date.now() - raceStartedAt <= parallelTimeoutMs;
    const parallelAttempt = runAttempt(parallelProvider, canClaimParallelResponse, parallelProvider, 'parallel')
      .then((result) => ({ ...result, role: 'parallel' }))
      .catch((error) => ({ ok: false, role: 'parallel', error }));
    const primaryAttempt = runAttempt(primaryProviders[0], () => true, primaryProviders[0], 'primary')
      .then((result) => ({ ...result, role: 'primary' }));
    const firstResult = await Promise.race([
      primaryAttempt,
      parallelAttempt,
      createTimeoutResult('Parallel provider race', parallelTimeoutMs),
    ]);

    if (firstResult.ok || firstResult.responseEnded || res.headersSent) return;
    lastError = firstResult.error || lastError;
    lastAttempt = firstResult.attempt || lastAttempt;
    parallelAttempt.catch(() => {});

    if (firstResult.role !== 'primary') {
      const primaryResult = await primaryAttempt;
      if (primaryResult.ok || primaryResult.responseEnded || res.headersSent) return;
      lastError = primaryResult.error || lastError;
      lastAttempt = primaryResult.attempt || lastAttempt;
    }

    for (const provider of primaryProviders.slice(1)) {
      const result = await runAttempt(provider, () => true);
      if (result.ok || (result.responseEnded && res.headersSent) || res.headersSent) return;
    }
  } else {
    for (const provider of primaryProviders) {
      const result = await runAttempt(provider);
      if (result.ok || (result.responseEnded && res.headersSent) || res.headersSent) return;
    }
  }

  if (fallbackProvider && !res.headersSent) {
    routeTrace.fallbackTriggered = true;
    const result = await runAttempt(fallbackProvider, () => true, fallbackProvider, 'fallback');
    if (result.ok || (result.responseEnded && res.headersSent) || res.headersSent) return;
  }

  // 所有 provider 都失败
  const status = lastError?.status || lastError?.response?.status || 500;
  const message = lastError?.message || 'All providers failed';
  if (lastAttempt) {
    updateProviderStats(lastAttempt.provider, {
      requestedModel: lastAttempt.requestedModel,
      actualModel: null,
      ip,
      promptTokens: 0,
      completionTokens: 0,
      success: false,
    }).catch(() => {});
    addLog(createLogEntry({
      providerName: lastAttempt.provider.name,
      requestedModel: lastAttempt.requestedModel,
      actualModel: null,
      ip,
      promptTokens: 0,
      completionTokens: 0,
      success: false,
      error: message,
      ...buildTimingFields(requestTrace),
    }, routeTrace));
  }
  res.status(status).json({ error: { message, providerErrors: [] } });
});

async function handleNonStream(client, payload, provider, model, requestedModel, ip, req, res, requestTrace, responseGate, responseOwner, canClaimResponse, timeoutMs, routeTrace) {
  const response = await runWithTimeout(
    (signal) => client.chat.completions.create(payload, { signal }),
    timeoutMs,
    `Model ${model} timed out after ${timeoutMs}ms`,
  );

  if (!claimResponse(responseGate, res, responseOwner, canClaimResponse)) {
    throw createResponseClaimError();
  }

  markFirstResponse(requestTrace);
  const actualModel = response.model || model;
  const usage = response.usage || {};

  updateProviderStats(provider, {
    requestedModel,
    actualModel,
    ip,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    success: true,
  }).catch(() => {});

  res.json(response);
  return {
    actualModel,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  };
}

async function handleStream(client, payload, provider, model, requestedModel, ip, req, res, requestTrace, responseGate, responseOwner, canClaimResponse, timeoutMs, routeTrace) {
  let actualModel = model;
  let promptTokens = 0;
  let completionTokens = 0;
  let completed = false;
  let headersOpened = false;

  const ensureStreamStarted = () => {
    if (headersOpened) return;
    if (!claimResponse(responseGate, res, responseOwner, canClaimResponse)) {
      throw createResponseClaimError();
    }
    markFirstResponse(requestTrace);
    setStreamHeaders(res);
    headersOpened = true;
  };

  const recordSuccess = () => {
    updateProviderStats(provider, {
      requestedModel,
      actualModel,
      ip,
      promptTokens,
      completionTokens,
      success: true,
    }).catch(() => {});
  };

  const createStream = (streamPayload) => runWithTimeout(
    (signal) => client.chat.completions.create(streamPayload, { signal }),
    timeoutMs,
    `Model ${model} timed out after ${timeoutMs}ms`,
  );

  const supportsRetryWithoutUsage = (error) => /stream_options|include_usage|unknown parameter|unsupported parameter|extra fields/i.test(error?.message || '');
  const shouldOpenEarly = provider?.specialRole === 'fallback';

  if (shouldOpenEarly) {
    ensureStreamStarted();
    writeSSE(res, formatSSE({
      id: 'ai-proxy-fallback-warmup',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    }));
  }

  let stream;
  const streamPayload = { ...payload, stream: true, stream_options: { include_usage: true } };
  try {
    stream = await createStream(streamPayload);
  } catch (error) {
    if (!supportsRetryWithoutUsage(error)) throw error;
    stream = await createStream({ ...payload, stream: true });
  }

  const rawStream = extractRawStream(stream);
  if (rawStream) {
    const iterator = rawStream[Symbol.asyncIterator]();
    let buffer = '';

    while (true) {
      const { value, done } = await readNextChunkWithTimeout(
        iterator,
        timeoutMs,
        `Model ${model} timed out after ${timeoutMs}ms`,
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
        timeoutMs,
        `Model ${model} timed out after ${timeoutMs}ms`,
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
  return { actualModel, promptTokens, completionTokens };
}

module.exports = router;