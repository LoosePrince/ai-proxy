/**
 * 响应抢占闸门 —— 并行竞速的正确性核心。
 *
 * 多个 provider 可能同时返回，但只有一个能写 HTTP 响应。闸门保证：
 *   1. 只有第一个 claim 成功者可以写响应
 *   2. parallel provider 受时间窗约束，超窗后即使先返回也不得抢占
 *
 * 状态是单请求作用域的（每个请求 new 一个），不是模块级全局状态。
 */

export type GateOwner = string;

export class ResponseClaimedError extends Error {
  readonly status = 409;
  readonly code = 'RESPONSE_CLAIMED';

  constructor() {
    super('Response already claimed by another provider');
    this.name = 'ResponseClaimedError';
  }
}

export interface ResponseGate {
  /** 尝试取得响应写入权；canClaim 用于施加时间窗等额外约束 */
  claim(owner: GateOwner, canClaim?: () => boolean): boolean;
  isClaimed(): boolean;
  isOwnedBy(owner: GateOwner): boolean;
  ownerOf(): GateOwner | null;
}

export function createResponseGate(): ResponseGate {
  let claimed = false;
  let owner: GateOwner | null = null;

  return {
    claim(nextOwner, canClaim = () => true) {
      if (claimed || !canClaim()) return false;
      claimed = true;
      owner = nextOwner;
      return true;
    },
    isClaimed: () => claimed,
    isOwnedBy: (nextOwner) => claimed && owner === nextOwner,
    ownerOf: () => owner,
  };
}

/** parallel provider 的竞速窗口：超过窗口后不再允许抢占 */
export function createRaceWindow(windowMs: number): () => boolean {
  const startedAt = Date.now();
  return () => Date.now() - startedAt <= windowMs;
}