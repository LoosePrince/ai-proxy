import { ResponseClaimedError, type GateOwner, type ResponseGate } from '../core/gate';
import { withTimeout } from '../core/timeout';
import type { JsonRecord } from '../core/protocol';
import { commitProviderMainResult, updateProviderScriptRun, type ProviderRecord } from '../db/repo/providers';

export type ScriptVariables = Record<string, string | number | boolean>;

export interface ScriptRequest {
  payload: JsonRecord;
  model: string;
  variables: ScriptVariables;
  signal: AbortSignal;
}

export interface ScriptResponse {
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  body: unknown;
  actualModel?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ScriptResult {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: unknown;
  actualModel: string;
  promptTokens: number;
  completionTokens: number;
}

class ScriptHttpError extends Error {
  readonly status: number;
  readonly response: { status: number };

  constructor(status: number) {
    super(`Provider 脚本返回 HTTP ${status}`);
    this.name = 'ScriptHttpError';
    this.status = status;
    this.response = { status };
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function normalizeResponse(value: unknown, model: string): Promise<ScriptResponse> {
  if (typeof Response !== 'undefined' && value instanceof Response) {
    const contentType = value.headers.get('content-type') ?? undefined;
    const text = await value.text();
    let body: unknown = text;
    if (contentType?.includes('json')) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: value.status, contentType, body };
  }
  if (isRecord(value) && 'body' in value) return value as unknown as ScriptResponse;
  return { body: value, actualModel: model };
}

function substituteVariables(source: string, variables: ScriptVariables): string {
  return source.replace(/\{\{\$([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_token, name: string) => {
    if (!(name in variables)) throw new Error(`脚本引用了未定义变量 ${name}`);
    return JSON.stringify(variables[name]);
  });
}

function createVariables(provider: ProviderRecord, overrides?: ScriptVariables): ScriptVariables {
  const variables: ScriptVariables = {};
  for (const definition of provider.variables) variables[definition.name] = definition.defaultValue;
  Object.assign(variables, overrides ?? {});
  for (const definition of provider.variables) {
    if (definition.required && (variables[definition.name] === '' || variables[definition.name] === undefined)) {
      throw new Error(`变量 ${definition.name} 不能为空`);
    }
  }
  return variables;
}

export async function executeProviderScript(
  provider: ProviderRecord,
  request: Omit<ScriptRequest, 'variables'> & { variables?: ScriptVariables },
  timeoutMs: number,
): Promise<ScriptResult> {
  if (!provider.requestScript.trim()) throw new Error('Provider 脚本不能为空');

  const variables = createVariables(provider, request.variables);
  const module = { exports: {} as unknown };
  const factory = new Function('module', 'exports', 'require', 'fetch', 'request', 'variables', 'signal', 'model', 'provider', `"use strict";\n${substituteVariables(provider.requestScript, variables)}`);

  const result = await withTimeout(
    async (signal) => {
      const contextRequest = {
        request: { payload: request.payload },
        payload: request.payload,
        model: request.model,
        variables,
        fetch,
        require,
        signal,
        provider,
      };
      factory(module, module.exports, require, fetch, contextRequest, variables, signal, request.model, provider);
      const exported = module.exports as unknown;
      const handler = typeof exported === 'function' ? exported : isRecord(exported) && typeof exported.default === 'function' ? exported.default : null;
      if (!handler) throw new Error('脚本必须通过 module.exports 导出函数');
      return normalizeResponse(await handler(contextRequest), request.model);
    },
    timeoutMs,
    `Provider ${provider.name} script timed out after ${timeoutMs}ms`,
    request.signal,
  );

  const body = result.body;
  const headers = result.headers ?? {};
  const contentType = result.contentType ?? headers['content-type'] ?? (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  return {
    status: result.status ?? 200,
    headers,
    contentType,
    body,
    actualModel: result.actualModel ?? request.model,
    promptTokens: Number(result.promptTokens) || 0,
    completionTokens: Number(result.completionTokens) || 0,
  };
}

export async function invokeProviderScript(args: {
  provider: ProviderRecord;
  request: Omit<ScriptRequest, 'variables'> & { variables?: ScriptVariables };
  timeoutMs: number;
  res: { headersSent: boolean; writableEnded: boolean; status: (code: number) => unknown; setHeader: (name: string, value: string) => unknown; json: (body: unknown) => unknown; end: (body?: unknown) => unknown };
  gate: ResponseGate;
  owner: GateOwner;
  canClaim?: () => boolean;
}): Promise<ScriptResult> {
  const result = await executeProviderScript(args.provider, args.request, args.timeoutMs);
  if (result.status < 200 || result.status >= 300) throw new ScriptHttpError(result.status);
  if (args.res.headersSent || args.res.writableEnded || !args.gate.claim(args.owner, args.canClaim)) {
    throw new ResponseClaimedError();
  }

  args.res.status(result.status);
  args.res.setHeader('Content-Type', result.contentType);
  for (const [name, value] of Object.entries(result.headers)) args.res.setHeader(name, value);

  if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) {
    args.res.end(result.body);
  } else {
    args.res.json(result.body);
  }
  return result;
}


export function sanitizeProviderScriptError(provider: ProviderRecord, error: unknown): string {
  let message = (error as Error)?.message ?? '脚本执行失败';
  for (const variable of provider.variables) {
    if (variable.type === 'password' && typeof variable.defaultValue === 'string' && variable.defaultValue) {
      message = message.split(variable.defaultValue).join('[REDACTED]');
    }
  }
  return message.slice(0, 1000);
}

export async function executeProviderMain(
  provider: ProviderRecord,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ updated: string[] }> {
  if (!provider.mainScript.trim()) return { updated: [] };

  const initial = createVariables(provider);
  const next = { ...initial };
  const declared = new Set(provider.variables.map((item) => item.name));
  const changed = new Set<string>();
  const api = {
    get: (name: string) => {
      if (!declared.has(name)) throw new Error(`变量 ${name} 未声明`);
      return next[name];
    },
    set: (name: string, value: string | number | boolean) => {
      if (!declared.has(name)) throw new Error(`变量 ${name} 未声明`);
      next[name] = value;
      changed.add(name);
    },
    patch: (values: ScriptVariables) => {
      for (const [name, value] of Object.entries(values)) api.set(name, value);
    },
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
  const module = { exports: {} as unknown };
  const factory = new AsyncFunction(
    'module',
    'exports',
    'variables',
    'fetch',
    'require',
    'signal',
    'provider',
    '"use strict";\n' + provider.mainScript,
  );
  const result = await withTimeout(
    async (executionSignal) => {
      const context = { variables: api, fetch, require, signal: executionSignal, provider };
      const returned = await factory(module, module.exports, api, fetch, require, executionSignal, provider);
      const exported = module.exports as unknown;
      const handler = typeof exported === 'function'
        ? exported
        : isRecord(exported) && typeof exported.default === 'function'
          ? exported.default
          : null;
      if (!handler) return returned;
      return handler(context);
    },
    timeoutMs,
    `Provider ${provider.name} main script timed out after ${timeoutMs}ms`,
    signal,
  );

  void result;
  if (changed.size > 0) {
    await commitProviderMainResult(provider.id, Object.fromEntries(
      [...changed].flatMap((name) => next[name] === undefined ? [] : [[name, next[name]]]),
    ) as ScriptVariables);
  } else {
    await updateProviderScriptRun(provider.id, { ok: true });
  }
  return { updated: [...changed] };
}

export function defaultScriptTemplate(): string {
  return `module.exports = async ({ request, model, variables, fetch, signal }) => {
  const response = await fetch('https://api.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request.payload, model }),
    signal,
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/json',
    body: await response.json(),
    actualModel: model,
  };
};`;
}