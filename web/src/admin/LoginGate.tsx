/**
 * 后台登录门禁。
 *
 * 只在后端声明 needAuth 时才出现。登录成功后由父组件重新拉取 auth-check，
 * 而不是本组件自己置一个「已登录」布尔 —— 登录态的唯一来源是服务端 session。
 */

import { useState } from 'react';
import { Alert, Button, Card, Form, Input } from 'antd';

import { adminApi } from '../api/client';

interface LoginForm {
  username: string;
  password: string;
}

export function LoginGate({ onSuccess }: { onSuccess: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (values: LoginForm) => {
    setBusy(true);
    setError(null);

    try {
      await adminApi.login(values.username, values.password);
      onSuccess();
    } catch (caught) {
      setError((caught as Error)?.message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-gate">
      <Card className="login-card" title="管理后台登录">
        {error ? <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} /> : null}

        <Form<LoginForm> layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input autoComplete="username" autoFocus />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={busy} block>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}