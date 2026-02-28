# AI Proxy Service

一个简单的 AI 代理服务，基于 Express.js 构建，提供与 OpenRouter API 兼容的接口。

## 功能特性

- 🚀 提供 OpenAI 兼容的 `/v1/chat/completions` 接口
- 💬 支持流式 (stream) 和非流式响应
- 🌐 内置 Web 聊天界面
- 🔧 可配置的默认模型
- 🐳 支持 Docker 部署

## 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd ai-proxy
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

复制模板文件并修改配置：

```bash
cp .env.template .env
```

编辑 `.env` 文件，填入你的 OpenRouter API Key：

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
PORT=3000
DEFAULT_MODEL=openrouter/free
```

> 💡 从 [OpenRouter](https://openrouter.ai/keys) 获取 API Key

### 4. 启动服务

```bash
node server.js
```

服务将在 http://localhost:3000 启动

## API 使用

### 聊天补全接口

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### 流式响应

将 `stream` 设置为 `true` 即可启用流式响应：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Docker 部署

### 构建镜像

```bash
docker build -t ai-proxy .
```

### 运行容器

```bash
docker run -d \
  -p 3000:3000 \
  -e OPENROUTER_API_KEY=your_api_key \
  ai-proxy
```

## 技术栈

- [Express.js](https://expressjs.com/) - Web 框架
- [Axios](https://axios-http.com/) - HTTP 客户端
- [OpenRouter](https://openrouter.ai/) - AI 模型聚合服务

## 许可证

[MIT](LICENSE)
