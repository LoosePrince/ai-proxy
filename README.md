# AI Proxy Service

基于 Express.js 的 AI 代理服务，提供 OpenAI 兼容的 `/v1/chat/completions` 接口，支持多 Provider 动态管理、数据库统计和管理后台。

## 功能特性

- OpenAI 兼容的 `/v1/chat/completions` 接口，统一 OpenAI SDK 调用
- 支持流式和非流式响应
- 多 Provider 动态管理（通过数据库配置，无需重启）
- 三种路由规则：单一平台 / 优先平台 / 负载均衡
- 按 model 名匹配 Provider，自动回退
- PostgreSQL 数据库记录请求数、Token 用量、IP 统计、模型映射（请求模型 vs 真实模型）
- 管理后台：Provider 增删改查、统计查看、实时日志
- 环境变量保底 Provider（不可通过后台关闭或删除）
- Docker 部署支持

## 快速开始

### 1. 克隆并安装

```bash
git clone <repository-url>
cd ai-proxy
npm install
```

### 2. 配置环境变量

```bash
cp .env.template .env
```

编辑 `.env`：

```env
# 必填：数据库连接
DATABASE_URL=postgresql://user:password@host:5432/dbname

# 可选：服务端口
PORT=3000

# 可选：管理后台登录（不设则无需登录）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_password

# 可选：保底 Provider（JSON 数组，不可通过后台关闭或删除）
FALLBACK_PROVIDERS=[{"name":"Kilo","baseUrl":"https://api.kilo.ai/api/gateway/v1","apiKey":"sk-xxx","models":["kilo-auto/free"],"priority":0}]
```

> `baseUrl` 使用 OpenAI SDK 格式（不含 `/chat/completions`，SDK 会自动拼接）。
> 不设 `FALLBACK_PROVIDERS` 时可通过管理后台添加 Provider。

### 3. 初始化数据库并启动

```bash
# 首次运行：推送数据库 schema
npx prisma db push

# 启动服务
node server.js
```

服务启动后：
- API: `http://localhost:3000/v1/chat/completions`
- 管理后台: `http://localhost:3000/admin`

## API 使用

### 聊天补全

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### 指定模型

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kilo-auto/free",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

指定 `model` 时，系统会优先选择支持该模型的 Provider，按路由规则选择；未指定模型时在所有启用 Provider 中按优先级选择。

## 路由规则

每个 Provider 可配置路由规则：

| 规则 | 说明 |
|------|------|
| `single` | 仅使用优先级最高的 Provider |
| `priority` | 按优先级从高到低依次尝试，失败后回退下一个 |
| `balanced` | 同优先级组内 round-robin 轮询 |

优先级数字越小越优先。Provider 失败时自动按优先级尝试下一个可用 Provider。

## 环境变量 Provider

`FALLBACK_PROVIDERS` 中的 Provider 标记为 `isEnv=true`：
- 启动时 upsert 到数据库
- 不可通过管理后台关闭或删除
- 环境变量中移除后，数据库中降级为普通 Provider（可管理）

## 管理后台

访问 `/admin` 进入管理后台（如果设置了 `ADMIN_USERNAME` 则需要登录）。

功能：
- 仪表盘：总请求数、Token 统计、成功率
- Provider 管理：添加 / 编辑 / 启用禁用 / 删除
- 模型统计：请求模型 vs 真实模型映射（如 `kilo-auto/free` -> `gpt-4o-mini`）
- IP 统计
- 最近请求日志（内存中，重启清空）

## 数据库

使用 PostgreSQL，单表 `providers` 存储配置和统计信息。

`stats` JSONB 字段结构：
- `totalRequests` / `successRequests` / `failedRequests` — 请求计数
- `totalPromptTokens` / `totalCompletionTokens` / `totalTokens` — Token 统计
- `models.{model}.requested` — 按请求模型的调用次数
- `models.{model}.actualResolved.{realModel}` — 请求模型到真实模型的映射
- `ips.{ip}.requests` / `ips.{ip}.tokens` — 按 IP 的统计

## Docker 部署

```bash
docker build -t ai-proxy .

docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/dbname" \
  -e FALLBACK_PROVIDERS='[{"name":"Kilo","baseUrl":"https://api.kilo.ai/api/gateway/v1","apiKey":"sk-xxx","models":["kilo-auto/free"]}]' \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secret \
  ai-proxy
```

容器启动时自动执行 `prisma migrate deploy` 同步数据库 schema。

## 技术栈

- [Express.js](https://expressjs.com/) - Web 框架
- [OpenAI Node.js SDK](https://github.com/openai/openai-node) - 统一 AI API 调用
- [Prisma](https://www.prisma.io/) - PostgreSQL ORM
- [express-session](https://github.com/expressjs/session) - Session 管理

## 许可证

[MIT](LICENSE)