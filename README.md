# AI Proxy Service

基于 Express.js 的 AI 代理服务，提供 OpenAI 兼容的 `/v1/chat/completions` 接口，支持多 Provider 动态管理、数据库统计和管理后台。

## 功能特性

- OpenAI 兼容的 `/v1/chat/completions` 接口，统一 OpenAI SDK 调用
- 支持流式和非流式响应
- 多 Provider 动态管理（通过数据库配置，无需重启）
- 三种全局路由规则：遵循优先级 / 随机 / 平均
- 支持全局默认超时、按 priority 单独覆盖超时、并行竞速窗口、保底超时
- 首页支持公开贡献 OpenAI 兼容 API，后端逐模型验证后保存为待启用 Provider
- 按 model 名匹配 Provider，自动回退
- PostgreSQL 数据库记录请求数、Token 用量、IP 统计、模型映射（请求模型 vs 真实模型）
- 管理后台：Provider 增删改查、全局路由 / 超时配置、统计查看、全链路请求日志
- 环境变量保底 Provider 可在后台关闭，但不可删除
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

# 可选：超时配置（管理后台中的全局配置会覆盖这里）
DEFAULT_RESPONSE_TIMEOUT_MS=30000
PARALLEL_RESPONSE_TIMEOUT_MS=14000
FALLBACK_RESPONSE_TIMEOUT_MS=30000
PRIORITY_RESPONSE_TIMEOUTS={"0":20000,"1":35000}

# 可选：保底 Provider（JSON 数组，可在后台关闭但不可删除）
FALLBACK_PROVIDERS=[{"name":"Kilo","baseUrl":"https://api.kilo.ai/api/gateway/v1","apiKey":"sk-xxx","models":["kilo-auto/free"],"rule":"priority","priority":0}]
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

指定 `model` 时，系统会优先选择支持该模型的普通 Provider 候选组，再按双重路由规则选择；未指定模型时在所有启用的普通 Provider 组中路由。

## 路由规则

路由规则分为两层：
- 全局路由：只读取虚拟控制条目 `priority=-1` 的 `rule` 字段，用来决定“先尝试哪个普通优先级组”。
- 内部路由：同一普通优先级组内共享一条 `rule`，用来决定“组内 Provider 的尝试顺序”。

注意：`priority=-1` 是专门的虚拟全局控制条目，不参与实际 AI 转发；普通 AI Provider 不再承担全局控制职责。后台不会在 Provider 列表中显示这条虚拟记录，而是通过独立的全局路由切换入口来修改它。

| 规则 | 全局层含义 | 内部层含义 |
|------|------|------|
| `priority` | 按优先级组从小到大依次尝试 | 按组内 `id ASC` 依次尝试 |
| `random` | 随机打乱内部优先级组顺序 | 随机打乱组内 Provider 顺序 |
| `average` | 对内部优先级组做 round-robin 轮换 | 对组内 Provider 做 round-robin 轮换 |

兼容旧配置：`balanced` 会按 `average` 处理，`single` 会按 `priority` 处理。优先级数字越小越优先。

## 超时与特殊 Provider

全局路由控制条目除了决定普通 Provider 的组间顺序，还负责存储下面这组运行参数：

- `defaultResponseTimeoutMs`：普通主路由默认超时。
- `priorityTimeouts`：按普通 Provider 的 `priority` 单独覆盖超时，未命中的优先级继承默认超时。
- `parallelTimeoutMs`：并行 Provider 的竞速窗口；超过窗口后它不能再抢占响应。
- `fallbackResponseTimeoutMs`：保底 Provider 的独立超时。
- `fallbackProvider`：三次主路由失败后才会调用。
- `parallelProvider`：首轮请求时可并行竞速，更快首包时直接采用其结果。

这些参数既可以通过管理后台维护，也可以通过环境变量提供默认值：

- `DEFAULT_RESPONSE_TIMEOUT_MS`
- `PARALLEL_RESPONSE_TIMEOUT_MS`
- `FALLBACK_RESPONSE_TIMEOUT_MS`
- `PRIORITY_RESPONSE_TIMEOUTS`

## 贡献 API 服务

首页提供公开贡献入口，也可以直接调用接口：

```bash
curl -X POST http://localhost:3000/api/contributions \
  -H "Content-Type: application/json" \
  -d '{
    "contributor": "123456@qq.com",
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-xxx",
    "models": "model-a,model-b"
  }'
```

提交字段中的 `contributor` 必须是邮箱或 GitHub 用户 ID；如果使用 QQ 邮箱，公开贡献列表会展示对应 QQ 头像。

提交后服务端会逐个模型发起一次真实 AI 请求，要求返回固定内容 `AI_PROXY_PROVIDER_OK`。任一模型失败都会整体拒绝，并返回模型级失败原因。

验证通过后：
- 新贡献会创建为 `isContributed=true` 的 Provider
- 同一个 `apiKey` 再次提交会更新已有贡献
- 贡献 Provider 默认 `enabled=false`，需要管理员在后台手动启用
- 公开贡献列表只返回脱敏信息，不返回 `apiKey`

## 环境变量 Provider

`FALLBACK_PROVIDERS` 中的 Provider 标记为 `isEnv=true`：
- 启动时 upsert 到数据库
- 可通过管理后台启用或关闭，重启不会强制恢复为启用
- 不可通过管理后台删除
- 环境变量中移除后，数据库中降级为普通 Provider（可管理）

## 管理后台

访问 `/admin` 进入管理后台（如果设置了 `ADMIN_USERNAME` 则需要登录）。

功能：
- 仪表盘：总请求数、Token 统计、成功率
- Provider 管理：添加 / 编辑 / 启停 / 删除，普通 Provider 只展示组内路由；全局路由通过独立切换入口控制
- 全局配置：统一维护组间路由、主路由默认超时、按 priority 覆盖超时、并行竞速窗口、保底超时
- 模型统计：请求模型 vs 真实模型映射（如 `kilo-auto/free` -> `gpt-4o-mini`）
- IP 统计
- 最近请求日志：直接显示请求模型、最终 Provider / 模型、主链路尝试明细、并行 / 保底链路状态

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