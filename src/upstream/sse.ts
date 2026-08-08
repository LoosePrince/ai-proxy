/**
 * SSE 帧处理 —— 纯函数，无 IO。
 *
 * 流式转发要同时做两件事：把上游字节原样透传给客户端，
 * 以及旁路解析出真实模型名与 token 用量。两者不能互相影响 ——
 * 解析失败绝不能中断透传。
 */

export interface SseScanState {
  /** 尚未凑成完整帧的残余字节 */
  buffer: string;
  actualModel: string | null;
  promptTokens: number;
  completionTokens: number;
}

export function createScanState(): SseScanState {
  return { buffer: '', actualModel: null, promptTokens: 0, completionTokens: 0 };
}

/** 从一帧中取出 data: 行内容，多行 data 按换行拼接 */
export function readFrameData(frame: string): string {
  return frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

interface ChunkLike {
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

/** 从已解析的 chunk 中提取模型名与用量。usage 通常只在最后一帧出现。 */
export function absorbChunk(state: SseScanState, chunk: ChunkLike): SseScanState {
  const next = { ...state };

  if (typeof chunk.model === 'string' && chunk.model) next.actualModel = chunk.model;

  if (chunk.usage) {
    const prompt = Number(chunk.usage.prompt_tokens);
    const completion = Number(chunk.usage.completion_tokens);
    if (Number.isFinite(prompt)) next.promptTokens = prompt;
    if (Number.isFinite(completion)) next.completionTokens = completion;
  }

  return next;
}

/**
 * 消费一段新到达的文本，返回更新后的状态。
 * 只处理已完整（以空行结尾）的帧，不完整部分留在 buffer 里等下一段。
 */
export function scanText(state: SseScanState, text: string): SseScanState {
  let next: SseScanState = { ...state, buffer: state.buffer + text.replace(/\r\n/g, '\n') };
  let cursor = 0;
  let boundary = next.buffer.indexOf('\n\n', cursor);

  while (boundary !== -1) {
    const frame = next.buffer.slice(cursor, boundary);
    const data = readFrameData(frame);

    if (data && data !== '[DONE]') {
      try {
        next = absorbChunk(next, JSON.parse(data) as ChunkLike);
      } catch {
        // 上游偶发非 JSON 事件（注释、心跳）不影响透传，忽略即可
      }
    }

    cursor = boundary + 2;
    boundary = next.buffer.indexOf('\n\n', cursor);
  }

  next.buffer = next.buffer.slice(cursor);
  return next;
}

export function formatSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

/** 上游拒绝 stream_options 时据此降级重试一次 */
export function isUnsupportedStreamOption(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  return /stream_options|include_usage|unknown parameter|unsupported parameter|extra fields/i.test(message);
}