/**
 * 公开路由：无需鉴权即可访问的两个入口。
 *
 *   GET  /api/public-stats    只读 global_usage 单行（旧实现是全表扫描 + 内存聚合）
 *   GET  /api/contributions   贡献列表，身份/API Key 脱敏、baseUrl 去查询串
 *   POST /api/contributions   贡献提交：SSRF 校验 → 逐模型真实调用验证 → 落库
 *
 * 贡献提交是唯一「服务端主动访问用户给定地址」的入口，因此 baseUrl 必须
 * 先过 ssrf.ts 的校验；纯粹的身份/内容归一化在 core/contribution.ts。
 * 贡献记录一律 enabled=false，需管理员在后台显式启用后才参与路由。
 */

import express, { type Request, type Response } from 'express';
import OpenAI from 'openai';

import {
  ValidationError,
  contributionProviderName,
  normalizeApiKey,
  normalizeContributor,
  normalizeModels,
} from '../core/contribution';
import {
  createProvider,
  findContributedByApiKey,
  listContributions,
  updateProvider,
} from '../db/repo/providers';
import { getPublicDetailedStats, getPublicStats } from '../db/repo/usage';
import { getConfig, invalidateConfig } from '../runtime/config-cache';
import { subscribePublicContent } from '../runtime/public-content-stream';
import type { ContributionModelResult, ContributionSubmitResult } from '../types/api';
import { toContributionDTO } from './dto';
import { assertPublicBaseUrl } from './ssrf';

const router = express.Router();

/** 贡献验证的单模型调用超时。太短会误判慢模型，太长会让提交请求悬挂。 */
const MODEL_PROBE_TIMEOUT_MS = 20_000;
/** 贡献记录的默认优先级：排在常规 provider 之后 */
const CONTRIBUTED_PRIORITY = 10;

function failed(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(error.status).json({ error: { message: error.message } });
    return;
  }
  console.error(`[Public] ${(error as Error)?.message ?? error}`);
  res.status(500).json({ error: { message: '服务暂时不可用' } });
}

router.get('/api/site-config', async (_req: Request, res: Response) => {
  try {
    const { settings } = await getConfig();
    res.json({
      adminEntryEnabled: settings.adminEntryEnabled,
      projectUrl: settings.projectUrl,
    });
  } catch (error) {
    failed(res, error);
  }
});

router.get('/api/public-stats', async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    res.json(await getPublicStats(config.settings.publicDetailedStatsEnabled));
  } catch (error) {
    failed(res, error);
  }
});

/**
 * 公开详细统计。默认关闭：披露的粒度比首页三个数字大得多，
 * 是否对外开放应由运营者显式决定，而不是随服务上线自动生效。
 */
router.get('/api/public-stats/detailed', async (_req: Request, res: Response) => {
  try {
    const config = await getConfig();
    if (!config.settings.publicDetailedStatsEnabled) {
      res.status(404).json({ error: { message: '公开详细统计未启用' } });
      return;
    }
    res.json(await getPublicDetailedStats());
  } catch (error) {
    failed(res, error);
  }
});

router.get('/api/request-content-stream', async (req: Request, res: Response) => {
  try {
    const config = await getConfig();
    if (!config.settings.publicRequestContentStreamEnabled) {
      res.status(404).json({ error: { message: '公开请求内容流未启用' } });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('event: ready\ndata: {"ready":true}\n\n');

    const unsubscribe = subscribePublicContent(res);
    if (!unsubscribe) {
      res.write('event: error\ndata: {"message":"订阅连接数已满"}\n\n');
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
  } catch (error) {
    if (!res.headersSent) failed(res, error);
    else res.end();
  }
});

router.get('/api/contributions', async (_req: Request, res: Response) => {
  try {
    const records = await listContributions(20);
    res.json(records.map(toContributionDTO));
  } catch (error) {
    failed(res, error);
  }
});

/** 提取错误里最有信息量的部分，避免把上游整个响应体回显给提交者 */
function probeErrorMessage(error: unknown): string {
  const candidate = error as { status?: number; message?: string; error?: { message?: string } };
  const status = candidate?.status;
  const message = candidate?.error?.message || candidate?.message || '验证失败';
  return (status ? `${status}: ${message}` : message).slice(0, 300);
}

/**
 * 真实调用一次上游确认模型可用。
 * 只要拿到 choices 即视为通过：部分模型只回 reasoning_content，内容为空不代表失败。
 */
async function probeModel(client: OpenAI, model: string): Promise<ContributionModelResult> {
  try {
    const response = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: '请回复一句简短内容，用于确认这个模型接口可以正常调用。' }],
        temperature: 0,
        max_tokens: 64,
      },
      { timeout: MODEL_PROBE_TIMEOUT_MS },
    );

    const message = response.choices?.[0]?.message as
      | { content?: string | null; reasoning_content?: string | null }
      | undefined;

    if (!message) return { model, ok: false, error: '模型接口未返回有效 choices' };

    const reply = (message.content || message.reasoning_content || '').trim();
    return { model, ok: true, reply: reply.slice(0, 500) };
  } catch (error) {
    return { model, ok: false, error: probeErrorMessage(error) };
  }
}

router.post('/api/contributions', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const identity = normalizeContributor(body.contributor ?? body.name);
    const apiKey = normalizeApiKey(body.apiKey);
    const models = normalizeModels(body.models);
    const baseUrl = await assertPublicBaseUrl(body.baseUrl);

    /*
     * 这里不用 upstream/client 的 LRU 缓存：贡献 key 是一次性的，
     * 缓存它们会把真正在服务流量的 provider 客户端挤出缓存。
     */
    const client = new OpenAI({ baseURL: baseUrl, apiKey, maxRetries: 0, timeout: MODEL_PROBE_TIMEOUT_MS });

    // 同一 apiKey 视为同一份贡献。已有模型已经验证过，本次不再重复请求。
    const existing = await findContributedByApiKey(apiKey);
    const verifiedModels = new Set(existing?.models ?? []);
    const modelsToProbe = models.filter((model) => !verifiedModels.has(model));

    /*
     * 只探测新增模型。已有模型即使本次上游短暂异常，也不应被重复验证覆盖。
     * 串行验证可以减少触发对方限流导致的误判。
     */
    const results: ContributionModelResult[] = models.map((model) =>
      verifiedModels.has(model)
        ? { model, ok: true, reply: '已有记录，跳过验证' }
        : { model, ok: false, error: '尚未验证' },
    );
    for (const model of modelsToProbe) {
      const result = await probeModel(client, model);
      const index = results.findIndex((item) => item.model === model);
      if (index >= 0) results[index] = result;
    }

    const availableModels = [...new Set([
      ...(existing?.models ?? []),
      ...results.filter((result) => result.ok).map((result) => result.model),
    ])];
    if (availableModels.length === 0) {
      res.status(422).json({
        success: false,
        error: { message: '没有验证通过的模型，贡献未保存' },
        results,
      });
      return;
    }

    // 只保存已有记录与本次验证通过的模型，失败模型不会进入路由池。
    const record = existing
      ? await updateProvider(existing.id, {
          baseUrl,
          apiKey,
          models: availableModels,
          contributor: identity.contributor,
          contributorType: identity.contributorType,
        })
      : await createProvider({
          name: contributionProviderName(apiKey),
          baseUrl,
          apiKey,
          models: availableModels,
          source: 'contributed',
          priority: CONTRIBUTED_PRIORITY,
          // 贡献记录默认停用，由管理员审核后启用
          enabled: false,
          contributor: identity.contributor,
          contributorType: identity.contributorType,
        });

    if (!record) throw new Error('contribution persisted but record not found');
    invalidateConfig();

    const dto = toContributionDTO(record);
    const payload: ContributionSubmitResult = {
      success: true,
      action: existing ? 'updated' : 'created',
      provider: {
        id: dto.id,
        name: dto.name,
        contributor: dto.contributor,
        contributorType: dto.contributorType,
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl,
        enabled: dto.enabled,
        modelCount: dto.modelCount,
      },
      results,
    };

    res.json(payload);
  } catch (error) {
    failed(res, error);
  }
});

export default router;