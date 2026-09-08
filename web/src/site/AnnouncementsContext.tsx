/**
 * 公告上下文。
 *
 * useAnnouncements() 内部有状态与弹窗，而顶栏铃铛和页面级弹窗渲染位置不同，
 * 因此由 Provider 统一持有一次，铃铛给 SiteHeader、弹窗挂 SitePage。
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface AnnouncementsContextValue {
  bell: ReactNode;
  autoPopModal: ReactNode;
  listModal: ReactNode;
  unreadCount: number;
}

export const AnnouncementsContext = createContext<AnnouncementsContextValue | null>(null);

export function useAnnouncementsContext(): AnnouncementsContextValue | null {
  return useContext(AnnouncementsContext);
}
