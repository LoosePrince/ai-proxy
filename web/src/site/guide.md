# AI Proxy 使用指南

## 快速开始

AI Proxy 提供兼容 OpenAI 的接口。打开首页的“接入方式”即可复制示例代码。

- API Base：当前服务地址，可保留或省略 `/v1`
- Chat Completions：`/v1/chat/completions`
- Responses：`/v1/responses`
- API Key：按照部署方配置填写

## Chat Completions

```bash
curl "$API_BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

## Responses

```bash
curl "$API_BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "input": "请介绍一下自己",
    "stream": false
  }'
```

## OpenAI SDK

将 SDK 的 `baseURL` 修改为本服务的 API Base：

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-proxy.example.com/v1',
  apiKey: 'your-api-key',
});

const result = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '你好' }],
});
```

## 请求说明

- 支持非流式和流式响应。
- 模型名称会按照已配置的模型进行相近匹配。
- 具体可用模型、请求限制和响应能力取决于当前服务配置。
- 不要在公开页面或客户端代码中暴露真实的敏感凭据。

## 项目地址

项目源码与问题反馈：{{PROJECT_URL}}