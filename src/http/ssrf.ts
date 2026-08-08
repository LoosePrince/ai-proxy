/**
 * 贡献接口的 SSRF 防护。
 *
 * `POST /api/contributions` 是**公开**入口，且服务端会主动向用户提交的
 * baseUrl 发起真实请求。若不校验，攻击者可借此探测内网服务
 * （云元数据端点、内部管理面等）。
 *
 * 校验分两层，两层都必须过：
 *   1. 直连 IP 字面量：直接判断是否落在私有段
 *   2. 域名：解析 DNS，检查**所有**解析结果（防 DNS rebinding 的单条绕过）
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ValidationError } from '../core/contribution';

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // 组播与保留段
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lowered = ip.toLowerCase();
  if (lowered === '::1' || lowered === '::') return true;
  if (lowered.startsWith('fc') || lowered.startsWith('fd')) return true; // 唯一本地地址
  if (lowered.startsWith('fe80')) return true; // link-local
  // IPv4-mapped，如 ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lowered);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

/**
 * 校验并规范化贡献者提交的 baseUrl。
 * 返回去掉查询串与尾斜杠的干净地址。
 */
export async function assertPublicBaseUrl(raw: unknown): Promise<string> {
  const value = String(raw ?? '').trim();
  if (!value) throw new ValidationError('Base URL 不能为空');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('Base URL 格式不正确');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('Base URL 只支持 http/https 协议');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ValidationError('Base URL 不能指向内网地址');
  } else {
    let records: Array<{ address: string }>;
    try {
      records = await lookup(host, { all: true });
    } catch {
      throw new ValidationError('Base URL 域名无法解析');
    }

    if (records.length === 0) throw new ValidationError('Base URL 域名无法解析');
    // 任一解析结果落在私有段即拒绝
    if (records.some((record) => isPrivateAddress(record.address))) {
      throw new ValidationError('Base URL 不能指向内网地址');
    }
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}