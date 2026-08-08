/**
 * 服务启动入口。
 *
 * 启动顺序是有意的，每一步都是下一步的前提：
 *   1. 迁移      —— 表不存在时后续任何读取都会失败
 *   2. 播种配置  —— settings 空表时热路径拿不到阈值
 *   3. 同步 env  —— FALLBACK_PROVIDERS 落库成真实 provider 行
 *   4. 预热快照  —— 把首个真实请求的配置重建成本前置到启动阶段
 *   5. 起后台任务 —— 写队列与保留清理
 *   6. 监听端口
 *
 * 数据库不可用时直接退出而不是带病启动：热路径依赖配置快照，
 * 没有快照的服务只会对每个请求返回 503，静默降级只会掩盖故障。
 */

import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import path from 'node:path';

import { getDb } from '../db/lsqlite';
import { runMigrations } from '../db/migrate';
import { syncEnvProviders, type EnvProviderSpec } from '../db/repo/providers';
import { seedSettingsFromEnv } from '../db/repo/settings';
import { invalidateConfig, warmConfig } from '../runtime/config-cache';
import { sweepRateLimitBuckets } from '../runtime/counters';
import { startRetentionSweeper, stopRetentionSweeper } from '../runtime/retention';
import { startWriteQueue, stopWriteQueue } from '../runtime/write-queue';
import adminRouter from './admin';
import proxyRouter from './proxy';
import publicRouter from './public';

const PORT = Number(process.env.PORT) || 3000;
/*
 * 前端构建产物目录，由 vite build 生成。
 *
 * 以项目根（cwd）为基准而不是 __dirname：本文件在 dev 下由 tsx 直接加载、
 * 在生产下作为编译产物运行，两种模式的模块作用域不一致（__dirname 在 ESM
 * 作用域里不存在），而 cwd 在两种模式下都是项目根。特殊部署可用 WEB_DIST 覆盖。
 */
const WEB_DIST = process.env.WEB_DIST
  ? path.resolve(process.env.WEB_DIST)
  : path.resolve(process.cwd(), 'web', 'dist');
const RATE_LIMIT_SWEEP_MS = 60_000;

/** FALLBACK_PROVIDERS 是一段 JSON 数组，解析失败只警告不阻塞启动 */
function parseEnvProviders(raw: string | undefined): EnvProviderSpec[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.error('[Startup] FALLBACK_PROVIDERS must be a JSON array');
      return [];
    }

    return parsed.map((item) => {
      const spec = (item ?? {}) as Record<string, unknown>;
      return {
        name: String(spec.name ?? ''),
        baseUrl: String(spec.baseUrl ?? ''),
        apiKey: String(spec.apiKey ?? ''),
        models: Array.isArray(spec.models) ? spec.models.map((m) => String(m)) : [],
        rule: spec.rule === undefined ? undefined : String(spec.rule),
        priority: Number(spec.priority ?? 0) || 0,
      };
    });
  } catch (error) {
    console.error(`[Startup] FALLBACK_PROVIDERS parse failed: ${(error as Error).message}`);
    return [];
  }
}

function buildApp(): express.Express {
  const app = express();

  // 反代之后取真实客户端 IP，限流与 IP 统计都依赖它
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/healthz', async (_req, res) => {
    const ok = await getDb().health();
    res.status(ok ? 200 : 503).json({ ok });
  });

  app.use(publicRouter);
  app.use(proxyRouter);
  app.use('/admin', adminRouter);

  app.use(express.static(WEB_DIST, { index: 'index.html' }));

  /*
   * SPA 兜底：/admin/xxx 之类的前端路由需要回落到 index.html。
   * 放在所有 API 路由之后，因此不会吞掉真实接口；
   * 显式排除 /api 与 /v1，避免未匹配的接口路径返回一个 HTML 页面。
   */
  app.get(/^\/(?!api\/|v1\/|admin\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'), (error) => {
      if (error) res.status(404).json({ error: { message: 'Not found' } });
    });
  });

  return app;
}

async function bootstrap(): Promise<void> {
  const result = await runMigrations();
  console.log(`[Startup] migrations applied=${result.applied.length} skipped=${result.skipped.length}`);

  await seedSettingsFromEnv();

  const specs = parseEnvProviders(process.env.FALLBACK_PROVIDERS);
  if (specs.length > 0) {
    await syncEnvProviders(specs);
    console.log(`[Startup] synced ${specs.length} env provider(s)`);
  } else {
    console.log('[Startup] FALLBACK_PROVIDERS not set, manage providers via /admin');
  }

  invalidateConfig();
  await warmConfig();

  startWriteQueue();
  startRetentionSweeper();

  const sweeper = setInterval(() => sweepRateLimitBuckets(), RATE_LIMIT_SWEEP_MS);
  sweeper.unref?.();

  const server = buildApp().listen(PORT, () => {
    console.log(`[Startup] listening on http://localhost:${PORT}`);
    console.log(`[Startup] admin console: http://localhost:${PORT}/admin`);
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`[Shutdown] ${signal} received`);

    clearInterval(sweeper);
    stopRetentionSweeper();
    server.close();
    // 先停止收新连接，再把队列里的追溯记录尽量写完
    await stopWriteQueue();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  console.error(`[Startup] failed: ${(error as Error).message}`);
  process.exit(1);
});