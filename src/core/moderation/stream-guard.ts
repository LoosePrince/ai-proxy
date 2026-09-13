/**
 * 流式输出审核的滞后缓冲（hold-back）守卫。
 *
 * 流式场景下「先发后审」不可逆，因此这里保留末尾 holdBackChars 个**正文字符**
 * 不立即发出：先把「即将放行的正文 + 仍在缓冲的正文」一起送审，通过才放行。
 * 这样跨 chunk 拆开的关键词（例如把敏感词拆成两帧）也能被拦住。
 *
 * 诚实的限制：滞后窗口只能覆盖窗口长度以内的跨块拆词。若某个违禁词的匹配
 * 证据分散在已经放行的前缀与当前窗口之间，超出窗口的部分无法撤销 —— 这是
 * 流式审核的固有代价，holdBackChars 越大越安全，代价是首字延迟。
 *
 * 队列按帧的原始文本（raw）与提取出的正文（text）成对保存：
 * 空正文帧（role / finish_reason / usage）正文长度为 0，不会推进安全水位，
 * 但会随队首一起按序释放，保证输出顺序与上游一致。
 */

import type { ModerationDecision } from './types';
import type { CompiledModerationPolicy } from './types';
import { evaluateText } from './evaluate';
import { sseFrameText, splitSseFrames } from './text';

interface HeldFrame {
  raw: string;
  text: string;
}

export interface FlushResult {
  /** 可以安全写出的原始文本；被拦截时为空串 */
  release: string;
  /** 命中时非 null，调用方据此走终止流程 */
  decision: ModerationDecision | null;
}

const EMPTY_RESULT: FlushResult = { release: '', decision: null };

export class StreamModerationGuard {
  private readonly held: HeldFrame[] = [];
  private heldText = '';
  private readonly holdBack: number;
  private readonly policy: CompiledModerationPolicy;
  private rawBuffer = '';

  constructor(policy: CompiledModerationPolicy) {
    this.policy = policy;
    this.holdBack = Math.max(0, Math.round(policy.holdBackChars));
  }

  /** 吞吐原始 SSE 字节：内部按空行切帧并提取正文 */
  pushRawSse(chunk: string): FlushResult {
    const { frames, rest } = splitSseFrames(this.rawBuffer, chunk);
    this.rawBuffer = rest;

    let release = '';
    for (const frame of frames) {
      const result = this.enqueue(frame, sseFrameText(frame));
      if (result.decision) return { release, decision: result.decision };
      release += result.release;
    }
    return release ? { release, decision: null } : EMPTY_RESULT;
  }

  /** 直接放入一个已知原始事件与其正文（Responses 流式转换路径使用） */
  pushEvent(raw: string, deltaText: string): FlushResult {
    return this.enqueue(raw, deltaText);
  }

  /** 流结束：把缓冲中剩余正文做终审，通过则全部放行 */
  flush(): FlushResult {
    let release = '';
    // 上游可能没有以空行结尾，残留的半帧原样放行（正文已并入 heldText 终审）
    if (this.rawBuffer) {
      const tail = this.rawBuffer;
      this.rawBuffer = '';
      const result = this.enqueue(tail, sseFrameText(tail));
      if (result.decision) return result;
      release += result.release;
    }

    const decision = this.evaluate(this.heldText);
    if (decision) return { release, decision };

    for (const frame of this.held) release += frame.raw;
    this.held.length = 0;
    this.heldText = '';
    return { release, decision: null };
  }

  private enqueue(raw: string, text: string): FlushResult {
    this.held.push({ raw, text });
    this.heldText += text;

    const safeLen = this.heldText.length - this.holdBack;
    if (safeLen <= 0) return EMPTY_RESULT;

    let candidateRaw = '';
    let candidateText = '';
    while (this.held.length > 0) {
      const frame = this.held[0]!;
      if (candidateText.length + frame.text.length > safeLen) break;
      this.held.shift();
      candidateRaw += frame.raw;
      candidateText += frame.text;
    }

    if (!candidateRaw) return EMPTY_RESULT;

    // 连同仍在缓冲的正文一起送审，覆盖候选窗口与滞后窗口的交界
    const decision = this.evaluate(candidateText + this.heldText);
    if (decision) {
      // 命中：本轮不放行，等待调用方终止；已放行的前缀无法收回（见文件头说明）
      return { release: '', decision };
    }

    this.heldText = this.heldText.slice(candidateText.length);
    return { release: candidateRaw, decision: null };
  }

  private evaluate(text: string): ModerationDecision | null {
    if (!text) return null;
    const decision = evaluateText(text, this.policy, 'output');
    return decision.blocked ? decision : null;
  }
}
