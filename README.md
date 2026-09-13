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
  core/      纯函数：routing / protocol / timeout / trace / gate / contribution / moderation（可单测）
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
- 公开详细状态页 `http://localhost:3000/status`（需在后台启用）
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

`DEFAULT_RESPONSE_TIMEOUT_MS`、`FALLBACK_RESPONSE_TIMEOUT_MS`、`PARALLEL_RESPONSE_TIMEOUT_MS`、`PRIORITY_RESPONSE_TIMEOUTS`、`IP_RATE_LIMIT_RPM`、`IP_RATE_LIMIT_PER_10_MIN`、`IP_RATE_LIMIT_PER_30_MIN`、`IP_RATE_LIMIT_HOURS`、`IP_RATE_LIMIT_PER_X_HOURS`、`LOG_RETENTION_DAYS`

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

## 内容审核

多层可配置的内容审核系统，默认**关闭**（`moderationEnabled=false`），与旧版「恶意内容检测」并存互不影响。

### 识别方向（类别）

固定类别契约，采用 OpenAI moderation 风格的层级命名：

```
sexual, sexual/minors
harassment, harassment/threatening
hate, hate/threatening
self-harm, self-harm/intent, self-harm/instructions
violence, violence/graphic
illicit, illicit/violent
profanity
```

子类别以 `父/子` 命名。策略里**未显式出现**的类别继承祖先的启用状态（只配父类别等于启用整棵子树），显式给子类别 `enabled=false` 又能单独关掉它。

### 敏感度

每个类别 0-100，越高越严格：命中阈值 `= 1 - 敏感度/100`。内置词库的单次命中分数为 0.5，两次 0.75，三次 0.875（收敛到 1）；因此默认敏感度下单个违禁词即拦截，调低敏感度则需要多次命中。

### 检测引擎与组合模式

引擎可插拔，未安装的库自动禁用、不影响启动：

| 引擎 | 依赖 | 类别能力 |
|---|---|---|
| `builtin-lexicon` | 无（内置） | 原生分类，唯一负责类别归属 |
| `whitz` | `whitz-word-detector`（可选依赖） | 原生分类，提供 leet/近似拼写模糊匹配 |
| `visulima` | `@visulima/content-safety`（可选依赖） | 19 语言词库，通用命中 |
| `obscenity` | `obscenity`（可选依赖） | 英文脏话稳健匹配，通用命中 |

组合模式（`combineMode`）：

- `strict` —— 任一启用引擎命中即拦截（**默认**，等价「通过所有库的检测」）
- `majority` —— 超过半数启用引擎命中才拦截
- `lenient` —— 全部启用引擎都命中才拦截

「启用引擎」指策略里勾选且依赖可用（`isAvailable()`）的引擎；未安装的库不计入分母。

> 这些库都是词表/正则匹配，不具备语义审核能力。`visulima` 与 `obscenity` 无法区分脏话与仇恨/色情，默认只归属到 `profanity`，避免把普通脏话误标成严重类别；需要更精细归属时在审核页按引擎勾选。

### 作用域层级

请求侧审核使用**全局默认策略**（输入与 Provider 无关）；响应侧审核按 `模型级 > Provider 级 > 全局默认` 解析。绑定指向已停用/已删除策略时静默退回上一层。

### 请求侧与响应侧

- 命中动作复用旧版恶意内容动作：`ban / block / throttle / empty / error / response`。`ban/block/throttle` 是 IP 级动作，本次拒绝并写入内存拦截或黑名单。
- 响应侧动作：`empty`（清空正文）/ `error`（错误码）/ `response`（替换为指定文本）。
- **流式响应审核**采用滞后缓冲：保留末尾 `holdBackChars` 个正文字符不立即发出，先把「即将放行 + 仍在缓冲」的正文一起送审，通过才放行，因此跨 chunk 拆开的关键词也能被拦住。
- 受限之处：滞后窗口只能覆盖窗口长度以内的跨块拆词，已放行的前缀无法撤回；`holdBackChars` 越大越安全，代价是首字延迟。
- 缓存命中会重跑一次输出审核，避免旧策略写入的缓存绕过新策略；被拦截的响应不写缓存。
- 输出被拦截记为 `rejected`（策略决定而非服务故障），不计入交付率分母。

### 审计与保留

命中事件写入 `moderation_events`，与请求明细同批落盘（保持热路径零 DB 往返），记录阶段、类别、引擎、分数、截断后的命中片段、动作、策略、IP 与最终 Provider/模型。`settings.moderationAuditRetentionDays` 控制清理，`0` 表示永不清理。该表仅供后台读取。

### 相关设置

| key | 说明 |
|---|---|
| `moderationEnabled` | 总开关，默认关闭 |
| `moderationInputEnabled` | 审核请求侧内容 |
| `moderationOutputEnabled` | 审核响应侧内容 |
| `moderationOutputStreamEnabled` | 流式响应逐块审核（关闭时流式跳过，仅审非流式） |
| `moderationAuditRetentionDays` | 审计日志保留天数，0 = 永不清理 |

### 扩展新引擎

实现 `ModerationDetector` 接口（同步、离线、内部吞异常）并注册进 `src/core/moderation/detectors.ts` 的 `MODERATION_DETECTORS` 即可；策略与后台会自动列出它。依赖用 `tryLoad` 懒加载，未安装时 `isAvailable()` 返回 false。

### 引擎显示「未安装」时怎么查

三个引擎都是 `optionalDependencies`，后台的「未安装」只是一个结论。原因只有四类，先跑自检命令：

```bash
npm run moderation:doctor
```

它会打印 Node 版本、`require(ESM)` 能力、每个引擎的加载失败原因与修复命令（任一可选依赖不可用时退出码为 1，可接进 CI/构建自检）。对照下表处理：

| 原因 | 现象 | 解决 |
|---|---|---|
| 依赖被裁掉 | 三个引擎全部「未安装」 | `npm install --include=optional @visulima/content-safety whitz-word-detector obscenity`；若 npm 配置或 CI/Docker 带了 `--omit=optional` / `omit=optional`，去掉它。注意 `--omit=dev` **不会**去掉可选依赖，`--omit=optional` 才会 |
| Node 不支持 `require(ESM)` | 只有 `visulima`/`whitz` 未安装，`obscenity` 可用 | `@visulima/content-safety` 与 `whitz-word-detector` 是纯 ESM 包，而 `obscenity` 提供 CJS 入口，所以旧 Node 上只有前者失败。升级到 **Node 22.12+ / 20.19+**（`@visulima/content-safety` 自身声明 `engines: ^22.14.0 \|\| >=24.10.0`）后重启服务 |
| 装了但导出不完整 | 显示「已安装但导出不完整」 | 依赖被其它工具改写或版本不兼容，删除 `node_modules/@visulima` 后重装 |
| 进程早于安装启动 | 文件明明在，仍是「未安装」 | 可用性在模块加载时定一次，`npm install` 后必须**重启服务**（`npm run dev` 需重启 watch 进程） |

Node 版本要求已写入 `package.json` 的 `engines`（`>=20.19.0`）。Dockerfile 的运行阶段用 `node:22-alpine`，并在 `npm ci --omit=dev` 后校验可选依赖确实存在，避免镜像裁剪后运行时静默降级。

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

- primary Provider 支持忽略大小写、分隔符、厂商前缀、版本后缀和轻微拼写差异的相近匹配，并调用其实际配置的模型名；该能力可在后台全局设置中关闭（`相近模型匹配`），关闭后完全不处理请求中的模型 ID，按未传模型处理。
- 单个 Provider 或单个模型可配置为「不参与模型 id 匹配」：它们永远不会被请求模型优先命中，只能通过正常路由（priority / random / average）被随机命中。
- fallback / parallel Provider 忽略自身模型列表，严格尝试客户端指定的原始模型名。
- 未找到相近 primary 模型时会视为未指定模型，仍可进入 parallel / fallback 特殊 Provider。

思考模式参数会继续透传；assistant 历史中的 `reasoning_content` 原样回传上游，同时兼容 `reasoning`、`thinking` 和思考内容块，避免 DeepSeek 多轮思考请求因缺失 `reasoning_content` 返回 400。Responses 输出会将思考内容转换为 reasoning item/事件。

> 这些端点是公开的，唯一防护是内存 IP 限流。后台可配置多个同时生效的窗口：每分钟 / 每 10 分钟 / 每 30 分钟 / 自定义 x 小时上限，任一窗口超限即拒绝（`0` 表示不启用对应窗口）。所有 IP 级拦截（黑名单、临时拦截 / 限流、请求上限）都在统一网关层执行，命中时请求体不会被读取。如果部署在公网并需要鉴权，请在反向代理层添加。

其他端点：

- `GET /v1/models` — 聚合所有启用 Provider 的模型
- `GET /healthz` — 服务与 Lsqlite 连通性
- `GET /api/public-stats` — 首页公开统计；成功率含缓存复用，不含客户端主动取消
- `GET /api/public-stats/detailed` — 近 30 天公开详细状态；仅在后台启用「公开详细统计」后开放
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

`/admin`，React Router 真实 URL，页面包括仪表盘、Provider、设置、内容审核、模型统计、IP 统计、请求日志、公告。

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
| `GET|POST /admin/api/moderation/policies`、`PUT|DELETE /admin/api/moderation/policies/:id` | 审核策略 CRUD |
| `GET /admin/api/moderation/detectors` | 检测引擎注册表与可用性 |
| `GET /admin/api/moderation/categories` | 类别体系元数据 |
| `GET /admin/api/moderation/bindings`、`PUT /admin/api/moderation/bindings`、`DELETE /admin/api/moderation/bindings/:id` | 作用域绑定 |
| `GET /admin/api/moderation/events` | 审核审计日志分页 |
| `GET /admin/api/usage?dimension=model|ip|provider&from&to` | 维度聚合 |
| `GET /admin/api/runtime` | 写队列与缓存运行状态 |
| `POST /admin/api/retention/sweep` | 手动触发明细清理 |

`apiKey` 永不出站，接口只返回 `hasApiKey: boolean`。

### 统计口径

请求结局分为 `upstream_ok`、`cache_hit`、`upstream_error`、`client_abort` 与 `rejected`。后台会同时展示两个不同的问题，避免把用户行为或缓存效果误判为上游质量：

- **交付率** = `(上游成功 + 缓存复用) / (总请求 - 客户端取消 - 被拦截/封禁)`。被网关拦截或封禁的请求是策略决定而非服务故障，不纳入分母，否则会虚拉低交付率。这是首页「成功率」的口径。
- **上游成功率** = `上游成功 / (上游成功 + 上游失败)`。只看实际打到上游的调用，缓存复用不会虚高这个数。

「公开详细统计」在后台的 **全局设置** 中启用。它只公开近 30 天的聚合趋势、请求结局和模型用量；不会公开 IP、Provider 名称、请求正文或 API Key。

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