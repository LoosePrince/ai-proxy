# AI Proxy Service

一个简单的 AI 代理服务，基于 Express.js 构建，提供 OpenAI 兼容的 `/v1/chat/completions` 接口，按配置自动回退。

## 功能特性

- 🚀 提供 OpenAI 兼容的 `/v1/chat/completions` 接口
- 💬 支持流式 (stream) 和非流式响应
- 🌐 内置 Web 聊天界面
- 🔧 可配置上游模型
- 🔁 上游失败时按顺序回退：Kilo（若已配置）→ OpenRouter（每日限额）→ SiliconFlow
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

编辑 `.env`，按需填入 API Key。示例：

```env
# 可选：配置后优先走 Kilo（见 https://kilo.ai/docs/gateway ）
KILO_API_KEY=your_kilo_api_key
# 可选，默认 https://api.kilo.ai/api/gateway/v1/chat/completions
# KILO_URL=
# 可选，默认 kilo-auto/free
# KILO_MODEL=kilo-auto/free

OPENROUTER_API_KEY=your_openrouter_api_key_here
SILICONFLOW_API_KEY=your_siliconflow_api_key_here
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1/chat/completions
PORT=3000
DEFAULT_MODEL=openrouter/free
```

> 💡 Kilo API Key 见 [Kilo 文档](https://kilo.ai/docs/gateway)；OpenRouter 见 [OpenRouter Keys](https://openrouter.ai/keys)；SiliconFlow 见 [SiliconFlow](https://siliconflow.cn)。

未配置 `KILO_API_KEY` 时从 OpenRouter 开始，失败或超限后回退 SiliconFlow。

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

## 回退策略说明

1. **Kilo**（仅当设置了 `KILO_API_KEY`）：使用 `KILO_MODEL`（默认 `kilo-auto/free`），请求 `KILO_URL` 指向的 OpenAI 兼容 Chat Completions 端点。失败则进入下一步。
2. **OpenRouter**：使用 `DEFAULT_MODEL`（默认 `openrouter/free`），每天最多尝试 50 次（进程内计数，服务重启会重置）。失败或达到当日上限则进入 SiliconFlow。
3. **SiliconFlow**：从下列白名单模型中随机选一个完成请求：
   - `Qwen/Qwen3.5-4B`
   - `PaddlePaddle/PaddleOCR-VL-1.5`
   - `PaddlePaddle/PaddleOCR-VL`
   - `THUDM/GLM-4.1V-9B-Thinking`
   - `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`
   - `Qwen/Qwen3-8B`
   - `THUDM/GLM-Z1-9B-0414`
   - `THUDM/GLM-4-9B-0414`
   - `deepseek-ai/DeepSeek-R1-Distill-Qwen-7B`
   - `Qwen/Qwen2.5-7B-Instruct`
   - `internlm/internlm2_5-7b-chat`

客户端始终使用同一套 `/v1/chat/completions` 调用方式，无需因回退链改动代码。

## Docker 部署

### 构建镜像

```bash
docker build -t ai-proxy .
```

### 运行容器

至少传入实际使用的上游 Key。若使用 Kilo 优先，示例：

```bash
docker run -d \
  -p 3000:3000 \
  -e KILO_API_KEY=your_kilo_api_key \
  -e OPENROUTER_API_KEY=your_openrouter_key \
  -e SILICONFLOW_API_KEY=your_siliconflow_key \
  ai-proxy
```

## 技术栈

- [Express.js](https://expressjs.com/) - Web 框架
- [Axios](https://axios-http.com/) - HTTP 客户端
- [Kilo AI Gateway](https://kilo.ai/docs/gateway) - 统一 OpenAI 兼容网关
- [OpenRouter](https://openrouter.ai/) - AI 模型聚合服务
- [SiliconFlow](https://siliconflow.cn/) - 回退通道

## 许可证

[MIT](LICENSE)
