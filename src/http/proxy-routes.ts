import type { Request, RequestHandler, Response } from 'express';

export type ProxyProtocol = 'chat' | 'responses';

export const PROXY_ROUTES = [
  { path: '/v1/chat/completions', protocol: 'chat' },
  { path: '/chat/completions', protocol: 'chat' },
  { path: '/v1/responses', protocol: 'responses' },
  { path: '/responses', protocol: 'responses' },
] as const satisfies ReadonlyArray<{ path: string; protocol: ProxyProtocol }>;

interface PostRegistrar {
  post(path: string, handler: RequestHandler): unknown;
}

export type ProxyRequestHandler = (
  req: Request,
  res: Response,
  protocol: ProxyProtocol,
) => Promise<void> | void;

/** 统一注册带 /v1 与省略 /v1 的协议入口，避免别名行为发生漂移。 */
export function registerProxyRoutes(target: PostRegistrar, handle: ProxyRequestHandler): void {
  for (const route of PROXY_ROUTES) {
    target.post(route.path, (req, res) => void handle(req, res, route.protocol));
  }
}