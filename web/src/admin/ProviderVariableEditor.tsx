import { Button, Card, Form, Input, InputNumber, Select, Space, Switch, type FormInstance } from 'antd';

import type { ProviderVariableDefinition } from '@shared/api';

export type ProviderVariableValue = ProviderVariableDefinition['defaultValue'];

export function scanProviderVariableNames(...sources: string[]): string[] {
  const names = new Set<string>();
  const dotPattern = /\bvariables\s*\.\s*([A-Za-z_$][\w$]*)/g;
  const bracketPattern = /\bvariables\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
  const methodPattern = /\bvariables\s*\.\s*(?:get|set)\s*\(\s*['"]([^'"]+)['"]/g;
  const placeholderPattern = /\{\{\$([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
  const apiMethods = new Set(['get', 'set', 'patch', 'delete']);

  for (const source of sources) {
    for (const pattern of [dotPattern, bracketPattern, methodPattern, placeholderPattern]) {
      pattern.lastIndex = 0;
      let match = pattern.exec(source);
      while (match) {
        const name = match[1];
        if (name && !apiMethods.has(name)) names.add(name);
        match = pattern.exec(source);
      }
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

export function syncProviderVariables(
  current: ProviderVariableDefinition[],
  referencedNames: string[],
): ProviderVariableDefinition[] {
  const currentByName = new Map(current.map((variable) => [variable.name, variable]));
  return referencedNames.map((name) => currentByName.get(name) ?? {
    name,
    label: humanizeVariableName(name),
    type: 'text',
    defaultValue: '',
    required: false,
  });
}

export function ProviderVariableEditor({
  form,
  autoSync,
}: {
  form: FormInstance;
  autoSync: boolean;
}) {
  const variables = Form.useWatch('variables', form) ?? [];

  return (
    <section className="provider-variable-editor">
      <Form.Item
        name="variablesAutoSync"
        valuePropName="checked"
        label="变量表单同步"
        extra="开启后，请求入口和主入口代码中引用的变量会自动生成、更新和移除，变量名只能由代码控制。"
      >
        <Switch checkedChildren="自动跟随代码" unCheckedChildren="手动维护" />
      </Form.Item>
      <Form.Item label="脚本变量" extra="变量值会持久化；密码变量在管理接口中不会回显。">
        <Form.List name="variables">
          {(fields, { add, remove }) => (
            <Space direction="vertical" className="control-full">
              {fields.map((field) => {
                const type = variables[field.name]?.type;
                return (
                  <Card key={field.key} size="small" className="provider-variable-card">
                    <Space wrap>
                      <Form.Item
                        {...field}
                        name={[field.name, 'name']}
                        noStyle
                        rules={[{ required: true, pattern: /^[A-Za-z_][A-Za-z0-9_]*$/, message: '变量名无效' }]}
                      >
                        <Input placeholder="变量名，如 api_token" disabled={autoSync} />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'label']} noStyle rules={[{ required: true, message: '请填写标签' }]}>
                        <Input placeholder="表单标签" />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'type']} noStyle initialValue="text">
                        <Select<ProviderVariableDefinition['type']>
                          className="provider-variable-type"
                          onChange={(nextType) => {
                            const current = form.getFieldValue(['variables', field.name, 'defaultValue']);
                            const defaultValue = nextType === 'switch'
                              ? false
                              : nextType === 'number'
                                ? Number(current) || 0
                                : String(current ?? '');
                            form.setFieldValue(['variables', field.name, 'defaultValue'], defaultValue);
                          }}
                          options={[
                            { value: 'text', label: '文本' },
                            { value: 'password', label: '密码' },
                            { value: 'number', label: '数字' },
                            { value: 'switch', label: '开关' },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        {...field}
                        name={[field.name, 'defaultValue']}
                        noStyle
                        valuePropName={type === 'switch' ? 'checked' : 'value'}
                      >
                        {type === 'switch'
                          ? <Switch />
                          : type === 'password'
                            ? <Input.Password placeholder={variables[field.name]?.secretConfigured ? '已配置，留空表示保持不变' : '默认值'} />
                            : type === 'number'
                              ? <InputNumber placeholder="默认值" />
                              : <Input placeholder="默认值" />}
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'required']} noStyle valuePropName="checked">
                        <Switch checkedChildren="必填" unCheckedChildren="可选" />
                      </Form.Item>
                      <Button danger type="link" disabled={autoSync} onClick={() => remove(field.name)}>移除</Button>
                    </Space>
                  </Card>
                );
              })}
              <Button
                type="dashed"
                disabled={autoSync}
                onClick={() => add({ name: '', label: '', type: 'text', defaultValue: '', required: false })}
              >
                添加变量
              </Button>
            </Space>
          )}
        </Form.List>
      </Form.Item>
    </section>
  );
}

function humanizeVariableName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words.replace(/^\w/, (character) => character.toUpperCase()) : name;
}