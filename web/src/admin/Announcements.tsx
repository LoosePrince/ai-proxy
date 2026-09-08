/**
 * 公告管理。
 *
 * 与其他后台页一致的模式：useAsync 拉列表 + message 反馈操作结果。
 * 公告一经修改建议立即生效（公开端点每次请求直读启用行，无缓存层），
 * 因此「启用」开关保存后首页即时可见。
 */

import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';

import { adminApi } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../lib/format';
import type { AnnouncementDTO, AnnouncementInput, AnnouncementLevel } from '@shared/api';

const LEVEL_OPTIONS: Array<{ label: string; value: AnnouncementLevel }> = [
  { label: '公告（info）', value: 'info' },
  { label: '注意（warning）', value: 'warning' },
  { label: '更新（success）', value: 'success' },
];

const LEVEL_TAG_COLOR: Record<AnnouncementLevel, string> = {
  info: 'blue',
  warning: 'orange',
  success: 'green',
};

interface FormValues {
  title: string;
  body: string;
  level: AnnouncementLevel;
  enabled: boolean;
}

function toFormValues(record: AnnouncementDTO | null): FormValues {
  return {
    title: record?.title ?? '',
    body: record?.body ?? '',
    level: record?.level ?? 'info',
    enabled: record?.enabled ?? true,
  };
}

export function AnnouncementsAdmin() {
  const announcements = useAsync(() => adminApi.announcements(), []);
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<AnnouncementDTO | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue(toFormValues(null));
    setModalOpen(true);
  };

  const openEdit = (record: AnnouncementDTO) => {
    setEditing(record);
    form.setFieldsValue(toFormValues(record));
    setModalOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const input: AnnouncementInput = values;
      if (editing) await adminApi.updateAnnouncement(editing.id, input);
      else await adminApi.createAnnouncement(input);
      message.success(editing ? '公告已更新' : '公告已创建');
      setModalOpen(false);
      announcements.reload();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: AnnouncementDTO) => {
    Modal.confirm({
      title: '删除公告',
      content: `确定删除「${record.title}」吗？该操作不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await adminApi.deleteAnnouncement(record.id);
          message.success('公告已删除');
          announcements.reload();
        } catch (error) {
          message.error((error as Error).message);
        }
      },
    });
  };

  const toggleEnabled = async (record: AnnouncementDTO, enabled: boolean) => {
    try {
      await adminApi.updateAnnouncement(record.id, { enabled });
      message.success(enabled ? '公告已启用' : '公告已停用');
      announcements.reload();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  return (
    <div className="stack">
      {announcements.status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="公告加载失败"
          description={announcements.error}
          action={<Button onClick={announcements.reload}>重试</Button>}
        />
      ) : null}

      <Card
        title="公告管理"
        extra={
          <Space>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
              新建公告
            </Button>
            <Button size="small" onClick={announcements.reload}>
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" className="paragraph-flush">
          启用的公告会出现在公开首页：访客首次进入时自动弹出最新一条未读公告，点开列表里的某条才算已读。
        </Typography.Paragraph>

        <Table<AnnouncementDTO>
          rowKey="id"
          size="small"
          loading={announcements.status === 'loading'}
          dataSource={announcements.data ?? []}
          pagination={false}
          columns={[
            { title: '标题', dataIndex: 'title', render: (title: string) => <strong>{title}</strong> },
            {
              title: '级别',
              dataIndex: 'level',
              width: 90,
              render: (level: AnnouncementLevel) => <Tag color={LEVEL_TAG_COLOR[level]}>{level}</Tag>,
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 80,
              render: (enabled: boolean, record) => (
                <Switch size="small" checked={enabled} onChange={(value) => void toggleEnabled(record, value)} />
              ),
            },
            {
              title: '更新时间',
              dataIndex: 'updatedAt',
              width: 170,
              render: formatDateTime,
            },
            {
              title: '操作',
              width: 130,
              render: (_: unknown, record) => (
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => openEdit(record)}>
                    编辑
                  </Button>
                  <Button type="link" size="small" danger onClick={() => void remove(record)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={editing ? '编辑公告' : '新建公告'}
        open={modalOpen}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnClose
        onOk={() => void save()}
        onCancel={() => setModalOpen(false)}
      >
        <Form form={form} layout="vertical" initialValues={toFormValues(null)}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '请输入标题' }, { max: 120, message: '标题不能超过 120 字' }]}
          >
            <Input placeholder="例如：系统将于周日 02:00-03:00 维护" />
          </Form.Item>
          <Form.Item
            name="body"
            label="正文"
            rules={[{ required: true, message: '请输入正文' }]}
            extra="支持 Markdown 格式（换行、加粗、链接等）。"
          >
            <Input.TextArea autoSize={{ minRows: 6, maxRows: 14 }} placeholder="公告正文……" />
          </Form.Item>
          <div className="settings-grid">
            <Form.Item name="level" label="级别">
              <Select options={LEVEL_OPTIONS} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
