/**
 * 前端 SSE 增量解析 —— 纯函数，与 UI 无关。
 *
 * 后端 upstream/sse.ts 做的是服务端旁路解析（提取 usage 与真实模型名），
 * 这里做的是客户端内容拼接，两者关注点不同，因此不共用实现。
 *
 * 关键约束：网络分片边界不保证落在帧边界上，所以必须保留残留缓冲区，
 * 否则会把一个被切成两半的 JSON 帧判为解析失败而丢字。
 */

export interface SseScanState {
  /** 未构成完整帧的残留字节 */
  buffer: string;
}

export function createSseState(): SseScanState {
  return { buffer: '' };
}

function dataOf(frame: string): string {
  return frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

interface ChunkPayload {
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
}

/** 从单帧中取出增量文本；非 JSON 事件与 [DONE] 返回空串 */
function deltaOf(frame: string): string {
  const data = dataOf(frame);
  if (!data || data === '[DONE]') return '';

  try {
    const parsed = JSON.parse(data) as ChunkPayload;
    const delta = parsed.choices?.[0]?.delta;
    return delta?.content || delta?.reasoning_content || '';
  } catch {
    // 心跳注释、自定义事件等非 JSON 帧直接跳过，不视为错误
    return '';
  }
}

/**
 * 喂入一段解码后的文本，返回本次新增的内容。
 * `flush=true` 时把残留缓冲也当作完整帧处理（流结束时调用）。
 */
export function scanSse(state: SseScanState, chunk: string, flush = false): string {
  state.buffer += chunk.replace(/\r\n/g, '\n');

  const frames = state.buffer.split('\n\n');
  state.buffer = flush ? '' : (frames.pop() ?? '');

  let delta = '';
  for (const frame of frames) delta += deltaOf(frame);

  if (flush && state.buffer.trim()) delta += deltaOf(state.buffer);
  return delta;
}

/** 流式能力探测，缺失时调用方降级为非流式请求 */
export function streamSupported(): boolean {
  return typeof ReadableStream !== 'undefined' && 'body' in Response.prototype;
}