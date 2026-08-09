import type { Response } from 'express';

import type { PublicRequestContentEventDTO } from '../types/api';

const MAX_SUBSCRIBERS = 100;
const subscribers = new Set<Response>();
let latest: PublicRequestContentEventDTO | null = null;

function frame(event: PublicRequestContentEventDTO): string {
  return `id: ${event.id}\nevent: request-content\ndata: ${JSON.stringify(event)}\n\n`;
}

export function subscribePublicContent(res: Response): (() => void) | null {
  if (subscribers.size >= MAX_SUBSCRIBERS) return null;
  subscribers.add(res);
  if (latest) res.write(frame(latest));
  return () => subscribers.delete(res);
}

export function publishPublicContent(event: PublicRequestContentEventDTO): void {
  latest = event;
  const payload = frame(event);
  for (const subscriber of subscribers) {
    if (subscriber.writableEnded || subscriber.destroyed) {
      subscribers.delete(subscriber);
      continue;
    }
    subscriber.write(payload);
    (subscriber as Response & { flush?: () => void }).flush?.();
  }
}

export function publicContentStreamStats(): { subscribers: number; hasLatest: boolean } {
  return { subscribers: subscribers.size, hasLatest: latest !== null };
}