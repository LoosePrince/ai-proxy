const crypto = require('crypto');
const dns = require('dns').promises;
const express = require('express');
const net = require('net');
const OpenAI = require('openai');
const prisma = require('../lib/prisma');

const router = express.Router();

const EXPECTED_REPLY = 'AI_PROXY_PROVIDER_OK';
const MAX_MODELS = 20;
const MAX_MODEL_TEST_MS = 20_000;

function normalizeModels(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))].slice(0, MAX_MODELS);
}

function sanitizeError(error) {
  const status = error.status || error.response?.status;
  const message = error.error?.message || error.message || '验证失败';
  return status ? `${status}: ${message}` : message;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:');
}

async function assertPublicBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new Error('Base URL 格式无效');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Base URL 只支持 http 或 https');
  }

  const hostname = parsed.hostname;
  const directIpVersion = net.isIP(hostname);
  if (directIpVersion === 4 && isPrivateIPv4(hostname)) throw new Error('Base URL 不能指向私有 IPv4 地址');
  if (directIpVersion === 6 && isPrivateIPv6(hostname)) throw new Error('Base URL 不能指向私有 IPv6 地址');

  if (!directIpVersion) {
    const records = await dns.lookup(hostname, { all: true });
    for (const record of records) {
      if (record.family === 4 && isPrivateIPv4(record.address)) throw new Error('Base URL 不能解析到私有 IPv4 地址');
      if (record.family === 6 && isPrivateIPv6(record.address)) throw new Error('Base URL 不能解析到私有 IPv6 地址');
    }
  }

  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function maskBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
  } catch (error) {
    return baseUrl;
  }
}

async function validateModel(client, model) {
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: `你是一个接口验证器。你必须只回复 ${EXPECTED_REPLY}，不要输出任何其他字符。`,
        },
        {
          role: 'user',
          content: `请只回复 ${EXPECTED_REPLY}`,
        },
      ],
      temperature: 0,
      max_tokens: 16,
    }, { timeout: MAX_MODEL_TEST_MS });

    const content = response.choices?.[0]?.message?.content?.trim() || '';
    const passed = content === EXPECTED_REPLY;
    return {
      model,
      passed,
      reply: content,
      error: passed ? null : `模型返回内容不匹配，实际返回：${content || '空内容'}`,
    };
  } catch (error) {
    return {
      model,
      passed: false,
      reply: '',
      error: sanitizeError(error),
    };
  }
}

function createContributionName(inputName, apiKey) {
  const cleanName = String(inputName || '').trim();
  if (cleanName) return cleanName.slice(0, 80);
  const digest = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
  return `贡献 Provider ${digest}`;
}

function isMissingContributionColumn(error) {
  return error.code === 'P2022' || /isContributed/i.test(error.message || '');
}

const migrationRequiredMessage = '贡献功能需要先应用数据库迁移：npx prisma migrate deploy';

router.get('/api/contributions', async (req, res) => {
  try {
    const providers = await prisma.provider.findMany({
      where: { isContributed: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    res.json(providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: maskBaseUrl(provider.baseUrl),
      modelCount: Array.isArray(provider.models) ? provider.models.length : 0,
      models: Array.isArray(provider.models) ? provider.models : [],
      enabled: provider.enabled,
      updatedAt: provider.updatedAt,
    })));
  } catch (error) {
    if (isMissingContributionColumn(error)) {
      return res.json([]);
    }
    res.status(500).json({ error: '贡献记录加载失败' });
  }
});

router.post('/api/contributions', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const apiKey = String(req.body.apiKey || '').trim();
    const models = normalizeModels(req.body.models);
    const baseUrl = await assertPublicBaseUrl(String(req.body.baseUrl || '').trim());

    if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });
    if (models.length === 0) return res.status(400).json({ error: '模型列表不能为空' });

    const client = new OpenAI({ baseURL: baseUrl, apiKey, timeout: MAX_MODEL_TEST_MS });
    const results = [];

    for (const model of models) {
      results.push(await validateModel(client, model));
    }

    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
      return res.status(422).json({
        success: false,
        error: '贡献验证失败，所有模型都必须通过验证',
        results,
      });
    }

    const providerName = createContributionName(name, apiKey);
    const existing = await prisma.provider.findFirst({ where: { isContributed: true, apiKey } });
    const data = {
      name: providerName,
      baseUrl,
      apiKey,
      models,
      rule: 'priority',
      priority: 10,
      enabled: false,
      isEnv: false,
      isContributed: true,
    };

    const provider = existing
      ? await prisma.provider.update({ where: { id: existing.id }, data })
      : await prisma.provider.create({ data: { ...data, stats: {} } });

    res.json({
      success: true,
      action: existing ? 'updated' : 'created',
      provider: {
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        modelCount: models.length,
      },
      results,
    });
  } catch (error) {
    if (isMissingContributionColumn(error)) {
      return res.status(503).json({ error: migrationRequiredMessage });
    }
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Provider 名称已存在，请更换名称后重试' });
    }
    res.status(400).json({ error: error.message || '贡献提交失败' });
  }
});

module.exports = router;