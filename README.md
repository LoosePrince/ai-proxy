# AI Proxy

OpenAI 兼容的 AI 代理服务。多 Provider 动态路由、并行竞速、保底兜底，全链路请求可追溯，自带管理后台。

持久化使用 [Lsqlite](https://github.com/LoosePrince/Lsqlite)（远程 HTTP SQL 服务，底层 SQLite），表结构完全规范化，不再有 JSON blob 统计字段。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | TypeScript + Express 5 + OpenAI Node SDK |
| 持久化 | Lsqlite（`POST /api/query`、`POST /api/transaction`） |
| 前端 | React 18 + Vite + Ant Design / Ant Design Mobile + Framer Motion |
| 测试 | `node --test` + tsx |

## 架构要点

Lsqlite 是远程服务，一条 SQL 等于一次 HTTPS 往返。因此代理热路径被设计为**零数据库往返**：

```
POST /v1/chat/completions 或 /v1/responses（也支持省略 /v1）
  ├─ 协议适配 → Responses / Chat 统一归一化为 Chat 热路径
  ├─ 读配置   → runtime/config-cache（内存快照，写操作后显式失效）
  ├─ IP 限流 / round-robin → runtime/counters（内存，带过期清理与上界）
  └─ 落盘     → runtime/write-queue（入队，后台按批合并为单次 transaction）
```

写队列把 `requests` 明细、`request_attempts` 明细和 4 张日聚合表的累加合并进**一个事务**，聚合列用 `on conflict do update set x = x + excluded.x` 原子累加，不存在读改写丢更新。

目录职责：

```
src/
  db/        Lsqlite 客户端、SQL DSL、迁移、仓储（唯一的 DB 访问出口）
  core/      纯函数：routing / protocol / timeout / trace / gate / contribution（可单测）
  runtime/   config-cache、write-queue、counters、retention
  upstream/  OpenAI 客户端 LRU、SSE 透传与 usage 旁路解析
  http/      proxy / public / admin / server
  types/     前后端共享 DTO（web 通过 @shared/api 引用）
web/         前端源码，构建产物 web/dist 由服务静态托管
```

## 数据模型

配置域

- `settings(key, value)` — 全局路由规则、超时、限流、日志保留天数
- `providers` — `kind` 为 `primary | fallback | parallel`，`source` 为 `managed | env | contributed`
- `provider_models` — 模型列表（取代 JSON 数组）
- `priority_groups(priority, rule, timeout_ms)` — 优先级组是实体，组内规则和超时挂在组上

明细域（每次请求都落盘，可追溯）

- `requests` — 首包时间、总耗时、最终 Provider / 模型、token、是否触发保底
- `request_attempts` — 每次尝试，含 `success | failed | claimed-by-other`
- `ips`、`models` — 维度表

聚合域（面板读取，避免全表扫描）

- `provider_usage_daily`、`model_usage_daily`、`ip_usage_daily`

`settings.logRetentionDays` 控制明细清理：`0` 表示永不清理；大于 0 时后台任务按天删 `requests`（`request_attempts` 级联删除），日聚合数据永久保留。

## 快速开始

```bash
npm install
cp .env.template .env   # 填入 LSQLITE_URL / LSQLITE_KEY
npm run build           # 编译后端 + 构建前端
npm start
```

开发模式：

```bash
npm run dev       # 后端热重载 (tsx watch)
npm run dev:web   # 前端 Vite dev server
```

启动后：

- Chat Completions `http://localhost:3000/v1/chat/completions` 或 `/chat/completions`
- Responses `http://localhost:3000/v1/responses` 或 `/responses`
- 首页 `http://localhost:3000/`
- 后台 `http://localhost:3000/admin`

服务启动时会自动执行迁移（幂等），无需手工建表。也可单独运行：

```bash
npm run db:migrate
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `LSQLITE_URL` | Lsqlite 服务地址 |
| `LSQLITE_KEY` | Bearer key |
| `LSQLITE_TIMEOUT_MS` | 单条 SQL 的 HTTP 超时，默认 15000 |
| `PORT` | 监听端口，默认 3000 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 后台账号，两者留空则后台无登录门禁 |
| `SESSION_SECRET` | session 密钥，生产务必更换 |
| `FALLBACK_PROVIDERS` | 启动时同步的 Provider JSON 数组，`source=env` |

以下变量**只在 settings 表首次初始化时作为种子值**写入，之后一律以数据库为准，改环境变量不会覆盖后台修改：

`DEFAULT_RESPONSE_TIMEOUT_MS`、`FALLBACK_RESPONSE_TIMEOUT_MS`、`PARALLEL_RESPONSE_TIMEOUT_MS`、`PRIORITY_RESPONSE_TIMEOUTS`、`IP_RATE_LIMIT_RPM`、`LOG_RETENTION_DAYS`

`PRIORITY_RESPONSE_TIMEOUTS` 为 JSON 对象（key 是 priority），种子写入 `priority_groups.timeout_ms`。

## 路由规则

两层排序，都由 `RoutingRule = priority | random | average` 描述：

| 规则 | 组间（`settings.globalRule`） | 组内（`priority_groups.rule`） |
|---|---|---|
| `priority` | 优先级数字从小到大 | 组内按 id 升序 |
| `random` | 随机打乱组顺序 | 随机打乱组内顺序 |
| `average` | 对组做 round-robin | 对组内 Provider 做 round-robin |

排完序后扁平为候选链，主链最多尝试 `maxPrimaryAttempts` 次（默认 3）。`kind=parallel` 的 Provider 在首轮参与竞速，超过 `parallelTimeoutMs` 后不再允许抢占响应；主链全部失败后调用 `kind=fallback`。

所有尝试（包括中途失败和被更快响应抢占的）都会写入 `request_attempts`，后台日志页可展开查看时间线。

## API

聊天补全（OpenAI 兼容，无需 API Key；`/v1` 可省略）：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

Responses API 使用同一套路由、重试、并行和兜底链路，支持流式与非流式格式：

```bash
curl -X POST http://localhost:3000/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-reasoner","input":"Hello","reasoning":{"effort":"high"}}'
```

不传 `model` 时在所有启用的 primary Provider 中路由。传 `model` 时：

- primary Provider 支持忽略大小写、分隔符、厂商前缀、版本后缀和轻微拼写差异的相近匹配，并调用其实际配置的模型名。
- fallback / parallel Provider 忽略自身模型列表，严格尝试客户端指定的原始模型名。
- 未找到相近 primary 模型时不会替换为无关模型，仍可进入 parallel / fallback 特殊 Provider。

思考模式参数会继续透传；assistant 历史中的 `reasoning_content` 原样回传上游，同时兼容 `reasoning`、`thinking` 和思考内容块，避免 DeepSeek 多轮思考请求因缺失 `reasoning_content` 返回 400。Responses 输出会将思考内容转换为 reasoning item/事件。

> 这些端点是公开的，唯一防护是内存 IP 限流（`ipRateLimitRpm`，`0` 表示不限流）。如果部署在公网并需要鉴权，请在反向代理层添加。

其他端点：

- `GET /v1/models` — 聚合所有启用 Provider 的模型
- `GET /healthz` — 服务与 Lsqlite 连通性
- `GET /api/public-stats` — 首页公开统计
- `GET|POST /api/contributions` — 公开贡献列表与提交

## 贡献 API

```bash
curl -X POST http://localhost:3000/api/contributions \
  -H "Content-Type: application/json" \
  -d '{"contributor":"123456@qq.com","baseUrl":"https://api.example.com/v1","apiKey":"sk-xxx","models":"model-a,model-b"}'
```

- `contributor` 必须是邮箱或 GitHub 用户 ID；公开输出中的邮箱仅保留星号脱敏后的本地 ID，不返回邮箱后缀或可反查 QQ ID 的头像
- 服务端逐个模型发起真实请求，要求返回固定内容才算通过，任一模型失败整体拒绝并返回模型级原因
- `baseUrl` 会做两层 SSRF 校验（IP 字面量私网段 + DNS 解析结果）
- 通过后创建 `source=contributed` 且 `enabled=false` 的 Provider，需管理员在后台启用
- 同一 `apiKey` 再次提交视为更新
- 公开列表不返回 `apiKey`

## 管理后台

`/admin`，React Router 真实 URL，页面包括仪表盘、Provider、设置、模型统计、IP 统计、请求日志。

Admin API：

| 端点 | 说明 |
|---|---|
| `POST /admin/api/login`、`/logout`、`GET /api/auth-check` | 会话 |
| `GET|POST /admin/api/providers`、`PUT|DELETE /admin/api/providers/:id` | Provider CRUD，按 `kind` 区分角色 |
| `GET /admin/api/priority-groups`、`PUT /admin/api/priority-groups/:priority` | 组内规则与超时 |
| `GET|PUT /admin/api/settings` | 全局配置 |
| `GET /admin/api/requests?limit&offset&success&requestedModel&ip&providerId&from&to` | 服务端分页日志 |
| `GET /admin/api/requests/:id` | 单请求含全部 attempts |
| `GET /admin/api/dashboard` | 概览聚合 |
| `GET /admin/api/usage?dimension=model|ip|provider&from&to` | 维度聚合 |
| `GET /admin/api/runtime` | 写队列与缓存运行状态 |
| `POST /admin/api/retention/sweep` | 手动触发明细清理 |

`apiKey` 永不出站，接口只返回 `hasApiKey: boolean`。

`source=env` 的 Provider 可在后台停用，但不可修改连接信息、不可删除。

## Docker

多阶段构建：构建阶段编译后端并打包前端，运行阶段只保留生产依赖与 `dist/`、`web/dist`。

```bash
docker build -t ai-proxy .

docker run -d -p 3000:3000 \
  -e LSQLITE_URL="https://lsqlite.example.com" \
  -e LSQLITE_KEY="lsq_xxx" \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secret \
  ai-proxy
```

## 测试

```bash
npm test        # core 纯函数单测
npm run typecheck
```

## 许可证

[MIT](LICENSE)