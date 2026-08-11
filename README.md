# waitqueue.js

[![CI](https://github.com/PeterGuy326/waitqueue.js/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/PeterGuy326/waitqueue.js/actions/workflows/ci.yml)

一个轻量的 HTTP 回调任务队列与并发调度器。业务系统只提交 `taskId`；WaitQueue 负责排队、并发占位和周期检查，真正的任务仍由业务回调服务执行。

> 当前定位是内部服务与二次开发基础设施。项目内置可选 Bearer token、精确回调 origin 允许列表、请求大小限制和轻量限流；为兼容本地开发，token 与允许列表默认为空，共享或生产环境必须显式开启并放在带 TLS 和用户认证的网关之后。

## 它解决什么问题

当业务任务已经存在，但需要统一控制“什么时候执行、同时最多执行多少个、何时释放槽位”时，可以用 WaitQueue 把调度逻辑从业务服务中拆出来：

- MySQL 持久化队列、并发上限和 cron 配置；
- Redis FIFO list 保存等待任务，hash/ZSET 保存 claim、退避与死信运行态；
- Lua 脚本原子完成领取、租约恢复、失败转移和重放，不突破队列并发上限；
- HTTP 回调驱动 `run`、`check`、`expire` 三类业务动作；
- Web 控制台展示真实 waiting/running/retrying/DLQ、等待年龄与回调/领取计数，并支持注册队列和提交任务；
- 核心服务无任务载荷、图表、消息总线等额外依赖，保持小而明确。

适合构建、导出、媒体处理、批量通知或第三方限流调用。不适合需要任务历史、优先级、复杂工作流或跨节点调度选主的系统。

## 工作原理

```text
调用方
  ├─ 注册 / 更新队列 ──────────> MySQL queue
  └─ 提交 taskId ─────────────> Redis waiting list
                                      │
                                  run cron
                                      │ 原子领取 + 并发占位
                                      v
                                Redis running hash
                                      │
                                      └─ HTTP callback
                                           ├─ run：启动业务任务
                                           ├─ check：返回已完成 taskId
                                           └─ expire：返回应清理 taskId
                                      │
                         失败/崩溃 ────┴──> retry ZSET ──> waiting
                                                └─ 超出预算 ──> DLQ
```

任务以 `LPUSH + RPOP` 的方式按 FIFO 领取。每次领取都会生成带截止时间的独立 claim token；租约只保护“领取到 `run` 返回 200”这一投递阶段，确认后的长任务不会因为固定 TTL 被重复启动。投递失败或进程崩溃会进入有界指数退避，耗尽预算后进入 DLQ。所有状态转换都比较 token 与 entry generation，迟到结果和旧重放请求不能改写新一代任务。

## 项目结构

```text
.
├── wait-queue/                 # Koa + TypeScript 调度服务
│   ├── sql/                    # MySQL 建表与迁移
│   ├── src/routes/             # HTTP 路由
│   ├── src/service/            # 队列、任务和控制面服务
│   ├── src/lib/                # cron、领取、回调与释放逻辑
│   ├── src/reliability/        # Redis 状态机、租约、退避与 DLQ
│   └── test/                   # Node.js 契约测试
├── admin-dashboard/            # Next.js + React 轻量实时控制台
├── examples/mock-hook.mjs      # 可直接运行的最小回调服务
├── Dockerfile                  # API、迁移器、控制台与示例回调的多阶段镜像
├── compose.yaml                # MySQL + Redis + API + 控制台一键编排
└── docs/                       # 控制台预览图
```

## 一条命令启动

已安装 Docker 与较新的 Docker Compose v2（`docker compose up` 需支持 `--wait`）时，在仓库根目录执行：

```bash
docker compose up --build --detach --wait
```

Compose 会按 `MySQL → 数据库迁移 → API → 控制台` 的顺序启动，并等待所有长期服务健康。随后访问：

- 控制台：[http://127.0.0.1:3001](http://127.0.0.1:3001)
- API 存活检查：[http://127.0.0.1:3000/health/live](http://127.0.0.1:3000/health/live)
- API 就绪检查：[http://127.0.0.1:3000/health/ready](http://127.0.0.1:3000/health/ready)
- Prometheus 指标：[http://127.0.0.1:3000/metrics](http://127.0.0.1:3000/metrics)

默认只监听 `127.0.0.1`，数据库凭据也只为隔离的本地体验准备。空 token 和空回调允许列表是兼容模式，不是生产安全默认值。共享或生产环境应先复制配置，替换两个数据库密码，用 `openssl rand -hex 32` 生成 API token，并按实际回调服务填写精确 origin：

```bash
cp .env.docker.example .env
# 编辑 .env：填写独立密码、API token、回调 origin 和外部控制台主机名
docker compose up --build --detach --wait
```

`HOOK_URL_ALLOWLIST` 是逗号分隔的精确 origin，例如 `https://worker.example.com,https://jobs.example.net:8443`；不支持通配符、路径、query 或 fragment。严格模式还会拒绝本机/私网字面量，并在真正连接时校验且固定 DNS 解析结果。生产暴露应通过带用户认证与 TLS 的网关完成，而不是把本项目端口直接绑定到公网。

查看状态与日志：

```bash
docker compose ps
docker compose logs --follow api dashboard
```

停止服务不会删除数据：

```bash
docker compose down
```

如需完整演示回调，再启用可选的 `demo` profile：

```bash
docker compose --profile demo up --build --detach --wait
```

此时注册队列时使用容器网络地址 `http://mock-hook:3101/callback`。如果已开启回调允许列表，还需在根目录 `.env` 中同时加入 `HOOK_URL_ALLOWLIST=http://mock-hook:3101` 和 `HOOK_URL_ALLOW_PRIVATE=true`。后者是仅供隔离演示环境的显式逃生开关，共享/生产必须保持 `false`。宿主机仍可通过 `http://127.0.0.1:3101/health` 检查示例回调。

MySQL 与 Redis 数据保存在命名卷中。只有确认要清空全部队列配置和运行态时，才执行 `docker compose down --volumes`；该操作不可从 Compose 自动恢复。

### 容器内迁移机制

`migrate` 是启动前的一次性服务。它只读取 `wait-queue/sql/V*.sql`，按版本顺序执行，并在 `waitqueue_schema_migrations` 表记录 SHA-256 校验和。MySQL advisory lock 保证同一数据库同一时刻只有一个迁移器工作；重复 `up` 会跳过已应用版本。`U*.sql` 是回滚脚本，永远不会被自动执行。

镜像固定使用仍受支持的 Node.js 24 LTS，并采用多阶段构建、非 root 运行和只读文件系统。MySQL、Redis 仅在 Compose 内部网络开放，默认不映射到宿主机。

## 手动跑通完整流程

### 0. 前置条件

不使用 Docker 时，完整运行需要：

- Node.js `>= 20.9`，推荐仍受支持的 Node.js 24 LTS；
- Corepack / pnpm 8；
- MySQL 5.7+ 或 8.x；
- Redis 6+。

以下命令都假设当前目录是仓库根目录。先启用 pnpm 并安装两端依赖：

```bash
corepack enable
corepack pnpm install:all
```

默认端口不会冲突：

| 服务 | 地址 |
| --- | --- |
| WaitQueue API | `http://127.0.0.1:3000` |
| 管理控制台 | `http://127.0.0.1:3001` |
| 示例回调 | `http://127.0.0.1:3101/callback` |

### 1. 创建数据库

确认 MySQL 与 Redis 已启动，然后创建数据库：

```bash
mysql -h 127.0.0.1 -u root -p \
  -e "CREATE DATABASE IF NOT EXISTS waitqueue CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;"
```

### 2. 配置、构建并迁移后端

```bash
cp wait-queue/.env.example wait-queue/.env
corepack pnpm --dir wait-queue build
corepack pnpm --dir wait-queue migrate
```

默认配置可直接连接本机 `waitqueue` 数据库和 Redis；非默认账号、端口或密码请在迁移前修改 `wait-queue/.env`。如需开启安全边界，还要在 `wait-queue/.env` 填写 `WAITQUEUE_API_TOKEN` 和 `HOOK_URL_ALLOWLIST`，并在后续的 `admin-dashboard/.env.local` 填写同一个 token。token 只由两个服务端读取，不应放入 `NEXT_PUBLIC_*` 变量。

下文的手动演示回调位于本机；若同时演示严格允许列表，请设置 `HOOK_URL_ALLOWLIST=http://127.0.0.1:3101` 和 `HOOK_URL_ALLOW_PRIVATE=true`。这个逃生开关只为隔离的本地演示准备，共享/生产必须保持 `false`。

迁移器会按版本执行 `V*.sql`、校验历史文件并跳过已经应用的版本；不要手工重放 SQL 文件。`U*.sql` 是破坏性回滚脚本，不属于正常启动流程。

从已有数据库升级前，先做可恢复性已验证的备份，并至少完成以下预检：

```sql
SELECT namespace, url, COUNT(*) AS duplicates
FROM queue GROUP BY namespace, url HAVING COUNT(*) > 1;

SELECT COUNT(*) AS negative_concurrency FROM queue WHERE count < 0;
```

两项结果都必须为零，否则 `V3` 的唯一约束或无符号并发数字段会失败。`V3` 还会变更表排序规则、字段定义和索引，在大表上可能重建或锁定表；请结合实际 MySQL 版本在维护窗口执行并预留回滚时间。

### 3. 启动三个进程

终端 A：启动可运行的示例回调。它会在收到 `run` 后立即把任务标记完成，随后由 `check` 释放槽位。

```bash
node examples/mock-hook.mjs
```

终端 B：启动调度服务。服务会先检查 MySQL、Redis 并加载队列配置，成功后才监听 3000。

```bash
corepack pnpm --dir wait-queue start
```

终端 C：启动控制台。Next.js 会把同源 `/waitqueue/*` 请求代理到后端，不需要开启 CORS。

```bash
cp admin-dashboard/.env.example admin-dashboard/.env.local
corepack pnpm --dir admin-dashboard dev
```

打开 [http://127.0.0.1:3001](http://127.0.0.1:3001) 即可进入控制室。

### 4. 注册队列并提交任务

也可以直接在控制台完成这两步。下面的 curl 便于验证 API：

```bash
# 本地兼容模式保持为空；开启鉴权时改为与后端一致的值。
export WAITQUEUE_API_TOKEN=''
```

```bash
curl -X POST http://127.0.0.1:3000/waitqueue/queue/newQueue \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${WAITQUEUE_API_TOKEN}" \
  -d '{
    "namespace": "demo",
    "hookUrl": "http://127.0.0.1:3101/callback",
    "currMaxCount": 2,
    "crontab": {
      "run": "*/2 * * * * *",
      "check": "*/3 * * * * *",
      "expire": "0 */1 * * * *"
    }
  }'

curl -X POST http://127.0.0.1:3000/waitqueue/scheduler/addTask \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${WAITQUEUE_API_TOKEN}" \
  -d '{
    "namespace": "demo",
    "hookUrl": "http://127.0.0.1:3101/callback",
    "taskId": "demo-task-001"
  }'
```

预期结果：

1. 控制台 waiting 短暂增加；
2. 示例回调打印 `[run] ... demo-task-001`；
3. 下一次 check 打印 `[check] completed=demo-task-001`；
4. 控制台 running 回到 0，槽位重新可用。

## 常用命令

| 目标 | 命令 |
| --- | --- |
| 安装全部依赖 | `corepack pnpm install:all` |
| 构建后端与控制台 | `corepack pnpm build` |
| 后端测试 + 控制台类型检查 | `corepack pnpm test` |
| 后端构建 | `corepack pnpm --dir wait-queue build` |
| 执行版本化数据库迁移 | `corepack pnpm --dir wait-queue migrate` |
| 后端测试 | `corepack pnpm --dir wait-queue test` |
| 后端启动 | `corepack pnpm --dir wait-queue start` |
| 控制台开发 | `corepack pnpm --dir admin-dashboard dev` |
| 控制台类型检查 | `corepack pnpm --dir admin-dashboard typecheck` |
| 控制台生产构建 | `corepack pnpm --dir admin-dashboard build` |
| 控制台生产启动 | `corepack pnpm --dir admin-dashboard start` |
| 校验 Compose 配置 | `corepack pnpm docker:config` |
| 一键构建并启动容器 | `corepack pnpm docker:up` |
| 停止容器并保留数据 | `corepack pnpm docker:down` |
| 跟踪 API 与控制台日志 | `corepack pnpm docker:logs` |

Docker Compose 与这些快捷命令都会自动读取项目根目录的 `.env`。共享环境请先从 `.env.docker.example` 复制并修改，后续的 `up`、`logs`、`down` 和 `--profile demo` 会持续使用同一份配置，避免重建时回退到本地默认凭据。

`wait-queue test` 会先重新编译，再使用 Node.js 内置 test runner 执行全部契约测试。

## CI 与贡献

所有提交到 `master` 的 push 和面向 `master` 的 Pull Request 都会运行以下稳定检查：

- `Backend tests`：安装后端锁定依赖并执行全部 Node.js 契约测试；
- `Dashboard typecheck`：独立安装控制台锁定依赖并执行 Next.js 类型生成与 TypeScript 检查；
- `Production build`：使用 Node.js 24.18.0 与 pnpm 8.15.9 构建前后端生产制品；
- `Dependency audit`：阻止前后端生产依赖中的 high / critical 已知漏洞；
- `Compose smoke`：等待以上四项并行检查通过后，在隔离的 Compose 项目和临时数据库凭据下启动完整栈，检查 API 存活/就绪、控制台可访问、迁移记录完整且重复迁移幂等，结束后删除测试容器与卷。

提交 PR 前建议先在仓库根目录运行：

```bash
corepack pnpm install:all
corepack pnpm test
corepack pnpm build
corepack pnpm --dir wait-queue audit --prod --audit-level high
corepack pnpm --dir admin-dashboard audit --prod --audit-level high
docker compose config --quiet
```

仓库管理员应在 GitHub `Settings → Branches → master` 的保护规则中启用 **Require status checks to pass before merging**，将 `Backend tests`、`Dashboard typecheck`、`Production build`、`Dependency audit` 与 `Compose smoke` 设为 required checks，并启用 **Require branches to be up to date before merging**。这样只有基于最新主干且全部检查通过的 PR 才能合入；CI 仅申请 `contents: read` 权限，不会发布制品或改写仓库。

## 配置

### 后端

配置文件示例位于 `wait-queue/.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `3000` | API 监听端口 |
| `HOOK_TIMEOUT_MS` | `10000` | 单次回调超时，单位毫秒 |
| `CHECK_TASK_DIFF_CRON` | `0 * * * * *` | 从 MySQL 同步队列配置的周期 |
| `CRON_TIMEZONE` | `Asia/Shanghai` | 所有 cron 使用的时区 |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL 地址 |
| `DB_DATABASE` | `waitqueue` | 数据库名 |
| `DB_USER` / `DB_PASSWORD` | `root` / 空 | MySQL 凭据 |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | Redis 地址 |
| `REDIS_PASSWORD` | 空 | Redis 密码 |
| `WAITQUEUE_API_TOKEN` | 空 | 非空时要求管理、队列和调度 API 携带同值 Bearer token |
| `HOOK_URL_ALLOWLIST` | 空 | 逗号分隔的精确 HTTP(S) origin；非空时拒绝其他回调地址 |
| `HOOK_URL_ALLOW_PRIVATE` | `false` | 仅本地演示使用；`true` 时允许已显式列入的本机/私网回调 |
| `REQUEST_BODY_LIMIT_BYTES` | `32768` | JSON 请求体上限，单位字节 |
| `RATE_LIMIT_MAX_REQUESTS` | `0` | 单进程、单客户端窗口内的最大请求数；`0` 关闭 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流固定窗口，单位毫秒 |
| `TASK_CLAIM_LEASE_MS` | `60000` | `run` 投递确认前的 claim 租约；必须大于 `HOOK_TIMEOUT_MS` |
| `TASK_MAX_RETRIES` | `5` | 首次投递失败后最多重试次数；`0` 表示直接进入 DLQ |
| `TASK_RETRY_BASE_DELAY_MS` | `1000` | 第一次重试的基础退避，单位毫秒 |
| `TASK_RETRY_MAX_DELAY_MS` | `60000` | 指数退避上限，单位毫秒且不得小于基础退避 |

端口、超时、安全与可靠性数值必须符合表中约束，无效值会让进程在启动时失败。实际重试时间还受 `crontab.run` 粒度影响；cron 使用“秒 分 时 日 月 周”六段格式。

### 控制台

配置文件示例位于 `admin-dashboard/.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WAITQUEUE_API_URL` | `http://127.0.0.1:3000` | Next.js 服务端代理的后端地址 |
| `WAITQUEUE_API_TOKEN` | 空 | 与后端相同的共享 token，由服务端代理注入 |
| `DASHBOARD_ALLOWED_HOSTS` | `127.0.0.1,localhost,[::1]` | 逗号分隔的精确控制台主机名，用于阻断 DNS rebinding |

三个变量都在 `start` 运行时由 Next.js 服务端读取，不会打进浏览器代码或镜像构建层。`DASHBOARD_ALLOWED_HOSTS` 不接受 scheme、路径或通配符，比较时忽略端口；共享域名部署必须显式加入外部 hostname，反向代理应保留或改写为该允许值。

## HTTP API

队列与管理 API 以 `/waitqueue` 开头；标准探针和抓取路径是 `/health/live`、`/health/ready` 与 `/metrics`。为兼容既有调用方，也保留对应的 `/waitqueue/*` 别名及旧 `/waitqueue/health`、`/waitqueue/ready` 路径。除 Prometheus 文本端点外，请求和响应使用 JSON。`WAITQUEUE_API_TOKEN` 非空时，管理、队列、调度和两个 metrics 路径都必须带 `Authorization: Bearer <token>`；健康检查与 `OPTIONS` 保持无鉴权，便于探针与预检。成功 JSON 响应统一为：

```json
{
  "code": 0,
  "msg": "success",
  "data": {}
}
```

参数错误返回 HTTP 400，未认证返回 401，资源不存在返回 404，活跃任务或过期 generation 冲突返回 409，请求体过大返回 413，限流返回 429 并带 `Retry-After`，不支持的方法返回 405，未处理异常返回 500。调用方应同时判断 HTTP 状态码和响应体 `code`。

### 安全边界

- API token 是服务间共享凭据，不是用户登录或细粒度授权。控制台的服务端代理只转发明确列入白名单的健康、概览、DLQ 与写入 API，丢弃浏览器传入的 Authorization、Cookie 和转发头，再注入服务端 token；metrics 刻意不经浏览器代理。任何能访问控制台的人仍可借代理操作队列，因此共享部署仍需认证网关。
- 回调允许列表按 WHATWG URL 归一化后精确比较 origin，每次真正发送前会再校验。严格模式拒绝 loopback、link-local、私网与本地主机名；域名的所有 DNS 结果也会在连接前校验，实际 socket 固定使用已校验地址。回调不跟随 3xx。`HOOK_URL_ALLOW_PRIVATE=true` 仅用于显式列入的隔离本地演示服务。
- 内存限流按 API 进程和直连 IP 生效，不信任 `X-Forwarded-For`。多副本或公网环境要由网关补充全局限流；对出站网络要求更强隔离时，应配置出站代理或网络策略。
- 所有写请求（成功或失败）与鉴权/限流拒绝都会生成结构化审计日志；请求体、token、Cookie、完整回调 URL 和 taskId 不会进入审计字段。

### 健康检查

`GET /health/live`（别名：`GET /waitqueue/health/live`；兼容旧路径：`GET /waitqueue/health`）

```json
{
  "code": 0,
  "msg": "success",
  "data": { "status": "ok" }
}
```

这是廉价存活探测，只说明 HTTP 进程可响应，不访问外部依赖。

`GET /health/ready`（别名：`GET /waitqueue/health/ready`；兼容旧路径：`GET /waitqueue/ready`）

就绪检查会并行执行 MySQL `SELECT 1` 与 Redis `PING`。两者都可用时返回 HTTP 200：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "status": "ready",
    "dependencies": { "mysql": "ok", "redis": "ok" }
  }
}
```

任一依赖不可用时返回 HTTP 503，响应只给出依赖状态，不暴露连接串或底层错误。新部署建议分别使用 `/health/ready` 与 `/health/live`；旧路径保持相同响应契约，不要求调用方同步升级。

### 控制台快照

`GET /waitqueue/admin/overview`

返回所有队列配置、Redis 运行态 gauge，以及当前 API 进程内的回调和领取累计计数。Redis 读取按队列常数复杂度执行，并使用 1 秒短缓存与 in-flight 合并：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "generatedAt": "2026-08-10T08:00:00.000Z",
    "metricsStartedAt": "2026-08-10T07:00:00.000Z",
    "summary": {
      "queueCount": 1,
      "waiting": 3,
      "running": 2,
      "retrying": 1,
      "deadLetters": 1,
      "oldestWaitingAt": "2026-08-10T07:57:48.000Z",
      "oldestWaitingAgeSeconds": 132,
      "callbackSuccesses": 28,
      "callbackFailures": 2,
      "claims": 24,
      "recovered": 1,
      "capacity": 5,
      "utilization": 40
    },
    "queues": [
      {
        "queueId": 12,
        "namespace": "demo",
        "hookUrl": "http://127.0.0.1:3101/callback",
        "concurrency": 5,
        "waiting": 3,
        "running": 2,
        "retrying": 1,
        "deadLetters": 1,
        "oldestWaitingAt": "2026-08-10T07:57:48.000Z",
        "oldestWaitingAgeSeconds": 132,
        "callbacks": { "success": 28, "failure": 2 },
        "claims": { "claimed": 24, "recovered": 1 },
        "available": 3,
        "utilization": 40,
        "crontab": {
          "run": "*/2 * * * * *",
          "check": "*/3 * * * * *",
          "expire": "0 */1 * * * *"
        },
        "updatedAt": "2026-08-10T07:58:00.000Z"
      }
    ]
  }
}
```

响应带 `Cache-Control: no-store`。`retrying` 是延迟重试 ZSET 当前数量，`deadLetters` 是 DLQ 当前数量；空等待队列的 `oldestWaitingAt` 和 `oldestWaitingAgeSeconds` 都为 `null`，真实刚入队才会返回年龄 `0`。旧版裸 waiting 项在有界迁移首次触达前可能没有入队时间，此时也返回 `null`。callback/claim 是从 `metricsStartedAt` 起由当前进程累计的值，重启会归零并更新该时间；接口不返回 taskId、claim token、回调 URL 或任务历史。

### Prometheus 抓取与告警

`GET /metrics`（别名：`GET /waitqueue/metrics`）返回 Prometheus 0.0.4 文本格式并带 `Cache-Control: no-store`。配置了 `WAITQUEUE_API_TOKEN` 时，该端点与管理 API 一样需要 Bearer token：

```bash
curl --fail \
  -H "Authorization: Bearer ${WAITQUEUE_API_TOKEN}" \
  http://127.0.0.1:3000/metrics
```

指标固定为以下低基数维度：

| 指标 | 类型 | Labels | 含义 |
| --- | --- | --- | --- |
| `waitqueue_queue_waiting_tasks` | gauge | `queue_id` | waiting FIFO（含迁移临时 FIFO）当前任务数 |
| `waitqueue_queue_running_tasks` | gauge | `queue_id` | 当前占用运行槽位的任务数 |
| `waitqueue_queue_retrying_tasks` | gauge | `queue_id` | 延迟重试 ZSET 当前任务数 |
| `waitqueue_queue_dead_letter_tasks` | gauge | `queue_id` | DLQ 当前任务数 |
| `waitqueue_queue_oldest_waiting_seconds` | gauge | `queue_id` | 最老 waiting 的年龄；空队列或未知时间不输出该 sample |
| `waitqueue_callback_attempts_total` | counter | `queue_id`, `type`, `outcome` | `run/check/expire` 调用的成功或失败次数 |
| `waitqueue_claim_transitions_total` | counter | `queue_id`, `outcome` | claimed、recovered、acknowledged 或 stale 状态迁移次数 |
| `waitqueue_retry_transitions_total` | counter | `queue_id`, `outcome`, `reason` | scheduled、promoted、dead_lettered 次数及受控原因 |

counter 存在 API 进程内，进程重启会归零，查询时应使用 `rate()` 或 `increase()`；多副本部署应保留 Prometheus 的 `instance` 维度后再聚合。gauge 来自 MySQL 队列目录和 Redis 实时状态，相同队列目录的并发请求会合并，并最多复用 1 秒。唯一队列维度是数据库生成的 `queue_id`，series 数量随队列数线性增长；用户可控的 `namespace` 只出现在 JSON 概览中，不进入 Prometheus。任何指标都不会把 `namespace`、`taskId`、claim token、`hookUrl`、原始异常或 HTTP 路径放入 label。

Prometheus 抓取示例（token 文件只包含 token 本身，并应使用只读 Secret 挂载）：

```yaml
scrape_configs:
  - job_name: waitqueue
    metrics_path: /metrics
    static_configs:
      - targets: ["waitqueue-api:3000"]
    authorization:
      type: Bearer
      credentials_file: /run/secrets/waitqueue_api_token
```

可从 DLQ、等待年龄和回调失败率三个方向建立最小告警集，阈值应按业务 SLO 调整：

```yaml
groups:
  - name: waitqueue
    rules:
      - alert: WaitQueueDeadLettersPresent
        expr: waitqueue_queue_dead_letter_tasks > 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "WaitQueue {{ $labels.queue_id }} has dead letters"

      - alert: WaitQueueOldestTaskStalled
        expr: waitqueue_queue_oldest_waiting_seconds > 300
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "WaitQueue waiting age exceeds five minutes"

      - alert: WaitQueueCallbackFailureRatioHigh
        expr: |
          sum by (queue_id) (rate(waitqueue_callback_attempts_total{outcome="failure"}[5m]))
          /
          clamp_min(sum by (queue_id) (rate(waitqueue_callback_attempts_total[5m])), 0.001)
          > 0.2
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "WaitQueue callback failure ratio exceeds 20%"
```

`/metrics` 依赖 MySQL 队列目录与 Redis；任一读取失败会让抓取返回非 2xx，使 Prometheus 的 `up` 变为 0。生产应同时告警 `up{job="waitqueue"} == 0`。不要为了抓取而把 API 端口直接暴露公网；应放在私有网络或受认证的监控入口后。

### 查询与重放死信

`GET /waitqueue/admin/deadLetters?queueId=12&offset=0&limit=50`

返回指定队列最近进入 DLQ 的任务；`limit` 默认为 50、最大 100：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 1,
    "offset": 0,
    "limit": 50,
    "items": [
      {
        "entryId": "33d443d1-17aa-45c7-958a-f21b39b25ea2",
        "taskId": "demo-task-001",
        "retryCount": 5,
        "failedAt": "2026-08-11T08:00:00.000Z",
        "reason": "callback_failed"
      }
    ]
  }
}
```

`reason` 只会是受控枚举 `callback_failed` 或 `lease_expired`；不会保存底层异常或回调 URL，查询响应与应用日志也不会暴露内部 claim token。查询响应带 `Cache-Control: no-store`。

`POST /waitqueue/admin/deadLetters/replay`

```json
{
  "queueId": 12,
  "taskId": "demo-task-001",
  "entryId": "33d443d1-17aa-45c7-958a-f21b39b25ea2"
}
```

重放会原子移除该条 DLQ、重置重试预算、生成新的 entry generation 并重新入队。并发重放只有一个成功；旧 `entryId` 不能重放后来再次失败的新一代任务。可用以下命令直接操作后端：

```bash
curl -H "Authorization: Bearer ${WAITQUEUE_API_TOKEN}" \
  'http://127.0.0.1:3000/waitqueue/admin/deadLetters?queueId=12&offset=0&limit=50'

curl -X POST http://127.0.0.1:3000/waitqueue/admin/deadLetters/replay \
  -H "Authorization: Bearer ${WAITQUEUE_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"queueId":12,"taskId":"demo-task-001","entryId":"33d443d1-17aa-45c7-958a-f21b39b25ea2"}'
```

### 注册或更新队列

`POST /waitqueue/queue/newQueue`

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `namespace` | 是 | 最长 64 字符 |
| `hookUrl` | 是 | 最长 255 字符，仅 HTTP(S) |
| `currMaxCount` | 否 | 1–1000 的整数，默认 5 |
| `crontab.run` | 否 | 最长 64 字符，默认每秒 |
| `crontab.check` | 否 | 最长 64 字符，默认每 10 秒 |
| `crontab.expire` | 否 | 最长 64 字符，默认每分钟 |

相同 `namespace + hookUrl` 再次提交会更新并发与 cron 配置。数据库使用 `utf8mb4_bin`，两个字段精确区分大小写。

### 提交任务

`POST /waitqueue/scheduler/addTask`

```json
{
  "namespace": "demo",
  "hookUrl": "http://127.0.0.1:3101/callback",
  "taskId": "demo-task-001"
}
```

`namespace` 和 `hookUrl` 必须与已注册队列完全一致。`taskId` 最长 256 字符，并在单个队列内充当活跃任务的幂等键：waiting、投递中、running、retry 或 DLQ 中的重复提交返回 HTTP 409；任务完成清理后可再次提交同一 ID。HTTP 投递仍是 at-least-once，调用方与回调方都必须保证幂等。

## 回调协议

同一个 `hookUrl` 接收三类 POST。每次请求都带数字型 `queueId` 和 `namespace`。

### `run`：启动任务

```json
{
  "type": "run",
  "queueId": 12,
  "namespace": "demo",
  "taskIds": ["demo-task-001"]
}
```

业务服务应在 `HOOK_TIMEOUT_MS` 内返回 HTTP 200。响应内容会被忽略；网络错误、超时或非 200 会按 `min(base × 2^(retryCount-1), max)` 延迟重试，最多执行 `TASK_MAX_RETRIES` 次额外投递，之后进入 DLQ。HTTP 200 与 Redis acknowledgement 无法组成跨系统事务，极端崩溃窗口仍可能重复投递，因此启动逻辑必须幂等。

### `check`：释放已完成任务

请求包含当前运行快照：

```json
{
  "type": "check",
  "queueId": 12,
  "namespace": "demo",
  "taskIds": ["demo-task-001"]
}
```

回调只返回已结束、可以释放槽位的 ID：

```json
{
  "data": { "taskIds": ["demo-task-001"] }
}
```

### `expire`：清理超时任务

```json
{
  "type": "expire",
  "queueId": 12,
  "namespace": "demo"
}
```

超时定义由业务方决定。响应同样必须是 `{ "data": { "taskIds": string[] } }`；结构无效时不会释放槽位。

## 管理控制台

控制台位于 `admin-dashboard/`，不是 mock 模板，也不是后端启动依赖。它提供：

- 10 秒自动刷新，页面不可见时暂停轮询；
- 基于 Ant Design 6 的紧凑工作台、浅/深主题和移动端布局；
- 真实 waiting、running、retrying、DLQ、最老等待与容量利用率；
- 当前进程 callback、claim、recovery 计数及起始时间；
- 左侧实时队列目录、Workbench 摘要与并发槽位视图；
- 队列搜索、并发占用和三类 cron 展示；
- 注册/更新队列、向指定队列提交任务、分页查询与 generation-safe DLQ 重放；
- 离线、过期、加载和空数据状态。

浏览器只请求当前控制台域名；Next.js 运行时服务端代理按白名单转发 API，并在配置时注入 `WAITQUEUE_API_TOKEN`，因此后端无需 CORS，token 也不进入浏览器 bundle。页面不伪造历史趋势、成功率或平均耗时，因为当前存储模型没有这些数据。

更多前端说明见 [admin-dashboard/README.md](admin-dashboard/README.md)。

## 已知边界

- API token 和回调允许列表为空时保持兼容模式；该模式只适合隔离的本地开发。共享环境必须显式配置两者。
- 内置 token 是单一共享凭据，控制台代理也不是用户登录系统；多用户环境仍需由网关补充认证、授权、TLS 和全局限流。
- `hookUrl` 会被服务端主动请求。严格模式已校验并固定 DNS 结果，但出站代理/网络策略仍是生产环境必要的纵深防御。不要在共享或生产环境开启 `HOOK_URL_ALLOW_PRIVATE`。
- cron 在应用进程内运行，没有 leader election；当前推荐单实例，多实例会重复触发 `check` / `expire`。
- Redis 是任务运行态的唯一存储，应按恢复目标配置持久化、高可用和备份。
- 当前是单节点 ioredis 客户端；使用 Redis Cluster 前应改为 Cluster 客户端，并给同一队列的 key 添加一致 hash tag。
- 没有任务载荷、优先级、取消或已完成任务历史；DLQ 是运维恢复面，不是审计级任务档案。
- 没有队列删除 API；数据库同步负责感知已有队列的配置变更。
- `check` / `expire` 失败会保留 acknowledged running 状态等待下一周期；业务任务何时完成或超时仍由回调方定义。
- 语义是 at-least-once，不是 exactly-once。claim 租约能恢复投递确认前的进程崩溃，但 HTTP 200 与 Redis acknowledgement 之间仍存在可能重复投递的窗口。
- 升级时旧版裸 token running claim 会通过有界游标审计获得一个完整 grace lease，再按新预算恢复；旧 waiting list 每个调度 tick 最多迁移 1000 条并保持 FIFO，完成后入队回到 O(1)。部署前应先停止旧调度进程，不支持新旧版本长期混跑或向旧版回滚后继续写入同一 Redis。
- 优雅退出会等待在途同步和回调，但没有独立强制退出 deadline。
- 自动化测试除单元契约外，还在 CI 的真实 Redis 7 上覆盖双客户端并发领取、指数退避、崩溃租约恢复、DLQ、generation-safe 重放和旧 claim 升级路径；Compose 冒烟覆盖真实 MySQL 迁移与 HTTP 管理链路。

## License

后端 `package.json` 声明 ISC。仓库尚未提供独立 LICENSE 文件；对外分发前应补齐许可证文本并确认前端依赖许可。
