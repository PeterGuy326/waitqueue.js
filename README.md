# waitqueue.js

[![CI](https://github.com/PeterGuy326/waitqueue.js/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/PeterGuy326/waitqueue.js/actions/workflows/ci.yml)

一个轻量的 HTTP 回调任务队列与并发调度器。业务系统只提交 `taskId`；WaitQueue 负责排队、并发占位和周期检查，真正的任务仍由业务回调服务执行。

![WaitQueue Control Room](docs/control-room.jpg)

> 当前定位是内部服务与二次开发基础设施。项目内置可选 Bearer token、精确回调 origin 允许列表、请求大小限制和轻量限流；为兼容本地开发，token 与允许列表默认为空，共享或生产环境必须显式开启并放在带 TLS 和用户认证的网关之后。

## 它解决什么问题

当业务任务已经存在，但需要统一控制“什么时候执行、同时最多执行多少个、何时释放槽位”时，可以用 WaitQueue 把调度逻辑从业务服务中拆出来：

- MySQL 持久化队列、并发上限和 cron 配置；
- Redis FIFO list 保存等待任务，hash 保存运行中的 claim；
- Lua 脚本原子领取任务，不突破队列并发上限；
- HTTP 回调驱动 `run`、`check`、`expire` 三类业务动作；
- Web 控制台展示真实 waiting/running/capacity，并支持注册队列和提交任务；
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
```

任务以 `LPUSH + RPOP` 的方式按 FIFO 领取。每次领取都会生成独立 claim token；迟到的旧回调结果不能释放同一 `taskId` 的新一代 claim。`run` 回调失败时，任务会释放槽位并放到当前等待队列之后重试。

## 项目结构

```text
.
├── wait-queue/                 # Koa + TypeScript 调度服务
│   ├── sql/                    # MySQL 建表与迁移
│   ├── src/routes/             # HTTP 路由
│   ├── src/service/            # 队列、任务和控制面服务
│   ├── src/lib/                # cron、领取、回调与释放逻辑
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
- API 存活检查：[http://127.0.0.1:3000/waitqueue/health](http://127.0.0.1:3000/waitqueue/health)
- API 就绪检查：[http://127.0.0.1:3000/waitqueue/ready](http://127.0.0.1:3000/waitqueue/ready)

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

端口、超时和安全数值必须符合表中约束，无效值会让进程在启动时失败。cron 使用“秒 分 时 日 月 周”六段格式。

### 控制台

配置文件示例位于 `admin-dashboard/.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WAITQUEUE_API_URL` | `http://127.0.0.1:3000` | Next.js 服务端代理的后端地址 |
| `WAITQUEUE_API_TOKEN` | 空 | 与后端相同的共享 token，由服务端代理注入 |
| `DASHBOARD_ALLOWED_HOSTS` | `127.0.0.1,localhost,[::1]` | 逗号分隔的精确控制台主机名，用于阻断 DNS rebinding |

三个变量都在 `start` 运行时由 Next.js 服务端读取，不会打进浏览器代码或镜像构建层。`DASHBOARD_ALLOWED_HOSTS` 不接受 scheme、路径或通配符，比较时忽略端口；共享域名部署必须显式加入外部 hostname，反向代理应保留或改写为该允许值。

## HTTP API

所有路径都以 `/waitqueue` 开头，请求和响应使用 JSON。`WAITQUEUE_API_TOKEN` 非空时，`/admin/*`、`/queue/*` 和 `/scheduler/*` 必须带 `Authorization: Bearer <token>`；`GET /health`、`GET /ready` 与 `OPTIONS` 保持无鉴权，便于探针与预检。成功响应统一为：

```json
{
  "code": 0,
  "msg": "success",
  "data": {}
}
```

参数错误返回 HTTP 400，未认证返回 401，资源不存在返回 404，请求体过大返回 413，限流返回 429 并带 `Retry-After`，不支持的方法返回 405，未处理异常返回 500。调用方应同时判断 HTTP 状态码和响应体 `code`。

### 安全边界

- API token 是服务间共享凭据，不是用户登录或细粒度授权。控制台的服务端代理只转发三个明确的 API，丢弃浏览器传入的 Authorization、Cookie 和转发头，再注入服务端 token。任何能访问控制台的人仍可借此操作队列，因此共享部署仍需认证网关。
- 回调允许列表按 WHATWG URL 归一化后精确比较 origin，每次真正发送前会再校验。严格模式拒绝 loopback、link-local、私网与本地主机名；域名的所有 DNS 结果也会在连接前校验，实际 socket 固定使用已校验地址。回调不跟随 3xx。`HOOK_URL_ALLOW_PRIVATE=true` 仅用于显式列入的隔离本地演示服务。
- 内存限流按 API 进程和直连 IP 生效，不信任 `X-Forwarded-For`。多副本或公网环境要由网关补充全局限流；对出站网络要求更强隔离时，应配置出站代理或网络策略。
- 所有写请求（成功或失败）与鉴权/限流拒绝都会生成结构化审计日志；请求体、token、Cookie、完整回调 URL 和 taskId 不会进入审计字段。

### 健康检查

`GET /waitqueue/health`

```json
{
  "code": 0,
  "msg": "success",
  "data": { "status": "ok" }
}
```

这是廉价存活探测，只说明 HTTP 进程可响应，不访问外部依赖。

`GET /waitqueue/ready`

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

任一依赖不可用时返回 HTTP 503，响应只给出依赖状态，不暴露连接串或底层错误。容器编排应使用 `/ready`，进程存活探针应使用 `/health`。

### 控制台快照

`GET /waitqueue/admin/overview`

返回所有队列配置，以及通过一个 Redis pipeline 读取的实时 waiting/running 数量：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "generatedAt": "2026-08-10T08:00:00.000Z",
    "summary": {
      "queueCount": 1,
      "waiting": 3,
      "running": 2,
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

响应带 `Cache-Control: no-store`。这是最终一致的瞬时快照，不包含 taskId、任务历史、吞吐或成功率。

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

`namespace` 和 `hookUrl` 必须与已注册队列完全一致。`taskId` 最长 256 字符；当前不会阻止重复提交，调用方与回调方必须保证幂等。

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

业务服务应在 `HOOK_TIMEOUT_MS` 内返回 HTTP 200。响应内容会被忽略；网络错误、超时或非 200 会重新入队，因此启动逻辑必须幂等。

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
- 队列总数、waiting、running、capacity 与利用率；
- 左侧实时队列目录、Workbench 摘要与并发槽位视图；
- 队列搜索、并发占用和三类 cron 展示；
- 注册/更新队列、向指定队列提交任务；
- 浅色/深色主题与移动端布局；
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
- 没有任务载荷、优先级、取消、任务明细查询、历史记录、退避、重试上限或死信队列。
- 没有队列删除 API；数据库同步负责感知已有队列的配置变更。
- `run` 失败会持续重试；`check` / `expire` 失败会保留 running 状态等待下一周期。
- running claim 当前没有租约时间；如果进程在领取成功、`run` 回调送达前崩溃，可能留下占用槽位但业务方未知的 orphan claim，需人工清理 Redis。对自动恢复有要求时应补充带 CAS 的超时租约回收。
- 优雅退出会等待在途同步和回调，但没有独立强制退出 deadline。
- 自动化测试使用 mock 覆盖 HTTP、校验、Redis key、原子领取/回退、claim 安全和 cron 同步；尚未自动覆盖真实 MySQL/Redis 故障恢复。

## License

后端 `package.json` 声明 ISC。仓库尚未提供独立 LICENSE 文件；对外分发前应补齐许可证文本并确认前端依赖许可。
