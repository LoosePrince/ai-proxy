/**
 * 站点公告。
 *
 * 已读追踪的口径（产品约定，实现严格遵守）：
 *   - 自动弹出的公告【不会】自动标记已读
 *   - 只有在「全部公告」列表里点开查看某条公告，才算已读（localStorage 持久化）
 *   - 未读数 = 公告总数 - 已读数，显示在顶栏铃铛上
 *   - 自动弹出只挑最新一条未读；弹窗内提供「查看全部公告」一键直达列表
 *
 * 已读按 id 存 localStorage。公告被删除后对应 id 残留无害，计数前会按现存公告过滤。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Empty, Modal, Space, Tag } from 'antd';
import { BellOutlined, NotificationOutlined, RightOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';

import { publicApi, type PublicAnnouncementDTO } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../lib/format';

const READ_STORAGE_KEY = 'announcements.read';
const AUTO_POP_STORAGE_KEY = 'announcements.autoPopAt';

const LEVEL_META: Record<PublicAnnouncementDTO['level'], { label: string; color: string }> = {
  info: { label: '公告', color: 'blue' },
  warning: { label: '注意', color: 'orange' },
  success: { label: '更新', color: 'green' },
};

function loadReadIds(): number[] {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

function saveReadIds(ids: number[]): void {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    // localStorage 不可用（隐私模式等）时退化为会话内记忆
  }
}

/** 同一会话只自动弹一次，避免刷新页面反复打扰 */
function hasAutoPoppedThisSession(): boolean {
  try {
    return sessionStorage.getItem(AUTO_POP_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function markAutoPopped(): void {
  try {
    sessionStorage.setItem(AUTO_POP_STORAGE_KEY, '1');
  } catch {
    // 同上，退化后只是每次刷新都会弹
  }
}

interface AnnouncementBodyProps {
  announcement: PublicAnnouncementDTO;
}

function AnnouncementBody({ announcement }: AnnouncementBodyProps) {
  return (
    <div className="announcement-body">
      <div className="announcement-meta">
        <Tag color={LEVEL_META[announcement.level].color}>{LEVEL_META[announcement.level].label}</Tag>
        <span className="faint">{formatDateTime(announcement.createdAt)}</span>
      </div>
      <div className="announcement-content">
        <ReactMarkdown>{announcement.body}</ReactMarkdown>
      </div>
    </div>
  );
}

interface ListModalProps {
  open: boolean;
  announcements: PublicAnnouncementDTO[];
  readIds: Set<number>;
  loading: boolean;
  onClose: () => void;
  onRead: (id: number) => void;
}

/** 全部公告列表：点开某条才算已读，未读项带圆点标识 */
function AnnouncementListModal({ open, announcements, readIds, loading, onClose, onRead }: ListModalProps) {
  const [viewingId, setViewingId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) setViewingId(null);
  }, [open]);

  const viewing = announcements.find((item) => item.id === viewingId) ?? null;

  const openItem = (id: number) => {
    setViewingId(id);
    onRead(id);
  };

  return (
    <Modal
      title={
        <Space size={8}>
          <NotificationOutlined />
          <span>全部公告</span>
        </Space>
      }
      open={open}
      footer={viewing ? <Button onClick={() => setViewingId(null)}>返回列表</Button> : null}
      onCancel={onClose}
      width={560}
      destroyOnClose
    >
      {viewing ? (
        <AnnouncementBody announcement={viewing} />
      ) : loading && announcements.length === 0 ? (
        <Empty description="加载中…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : announcements.length === 0 ? (
        <Empty description="暂无公告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="announcement-list">
          {announcements.map((announcement) => (
            <button
              key={announcement.id}
              type="button"
              className={`announcement-item${readIds.has(announcement.id) ? ' read' : ''}`}
              onClick={() => openItem(announcement.id)}
            >
              <span className="announcement-item-main">
                <span className="announcement-item-title">
                  {!readIds.has(announcement.id) ? <i className="announcement-unread-dot" aria-label="未读" /> : null}
                  {announcement.title}
                </span>
                <span className="faint">{formatDateTime(announcement.createdAt)}</span>
              </span>
              <Tag color={LEVEL_META[announcement.level].color}>{LEVEL_META[announcement.level].label}</Tag>
              <RightOutlined className="announcement-item-arrow" />
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function useAnnouncements() {
  const announcements = useAsync(() => publicApi.announcements(), []);
  const [readIds, setReadIds] = useState<Set<number>>(() => new Set(loadReadIds()));
  const [listOpen, setListOpen] = useState(false);
  const [autoPopOpen, setAutoPopOpen] = useState(false);

  const items = announcements.data ?? [];
  // 已读 id 按现存公告过滤，避免被删公告的 id 永久占位
  const existingIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const unread = useMemo(
    () => items.filter((item) => !readIds.has(item.id)),
    [items, readIds],
  );
  const unreadCount = useMemo(
    () => unread.filter((item) => existingIds.has(item.id)).length,
    [unread, existingIds],
  );

  const markRead = useCallback((id: number) => {
    setReadIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      saveReadIds([...next]);
      return next;
    });
  }, []);

  const openList = useCallback(() => setListOpen(true), []);
  const closeList = useCallback(() => setListOpen(false), []);

  // 进入首页且有未读公告时，自动弹出最新一条未读；每次会话最多弹一次
  useEffect(() => {
    if (announcements.status !== 'success') return;
    if (hasAutoPoppedThisSession()) return;
    const latestUnread = unread[0];
    if (!latestUnread) return;
    setAutoPopOpen(true);
    markAutoPopped();
    // unread 是派生值，只在公告数据或已读集合变化时重新评估
  }, [announcements.status, unread]);

  const latestAutoPop = unread[0] ?? null;

  const autoPopModal = latestAutoPop ? (
    <Modal
      title={
        <Space size={8}>
          <NotificationOutlined />
          <span>{latestAutoPop.title}</span>
        </Space>
      }
      open={autoPopOpen}
      onCancel={() => setAutoPopOpen(false)}
      width={520}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={() => setAutoPopOpen(false)}>关闭</Button>
          <Button
            type="primary"
            icon={<RightOutlined />}
            iconPosition="end"
            onClick={() => {
              setAutoPopOpen(false);
              openList();
            }}
          >
            查看全部公告
          </Button>
        </Space>
      }
    >
      <AnnouncementBody announcement={latestAutoPop} />
    </Modal>
  ) : null;

  const listModal = (
    <AnnouncementListModal
      open={listOpen}
      announcements={items}
      readIds={readIds}
      loading={announcements.status === 'loading'}
      onClose={closeList}
      onRead={markRead}
    />
  );

  const bell = (
    <Badge count={unreadCount} size="small" offset={[-2, 4]}>
      <Button
        className="header-icon-button"
        icon={<BellOutlined />}
        aria-label={`公告（${unreadCount} 条未读）`}
        onClick={openList}
      >
        <span className="header-action-label">公告</span>
      </Button>
    </Badge>
  );

  return { bell, autoPopModal, listModal, unreadCount };
}
