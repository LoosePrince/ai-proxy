/**
 * API Base 推导。
 *
 * 服务对外地址不写死在配置里：页面本身就是从该服务提供的，
 * 因此 window.location.origin 天然就是正确的 base。反代换域名、
 * 端口变化、局域网访问都自动正确，无需改前端。
 */

export function apiOrigin(): string {
  return window.location.origin || `${window.location.protocol}//${window.location.host}`;
}

export function apiBase(): string {
  return `${apiOrigin()}/v1`;
}