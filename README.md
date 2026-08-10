# waitqueue.js

一个轻量的 HTTP 回调任务队列与并发调度器。业务系统只提交 `taskId`；WaitQueue 负责排队、并发占位和周期检查，真正的任务仍由业务回调服务执行。

![WaitQueue Control Room](docs/control-room.jpg)

> 当前定位是内部服务与二次开发基础设施。API 尚未内置鉴权，`hookUrl` 也会被服务端主动访问；生产部署必须放在可信网络或认证网关之后。

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
├── admin-dashboard/            # Next.js + Arco 实时控制台
├── examples/mock-hook.mjs      # 可直接运行的最小回调服务
└── docs/                       # 控制台预览图
```

## 五分钟跑通完整流程

### 0. 前置条件

完整运行需要：

- Node.js `>= 20.9`；
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

### 1. 初始化数据库

确认 MySQL 与 Redis 已启动，然后创建数据库并执行迁移：

```bash
mysql -h 127.0.0.1 -u root -p \
  -e "CREATE DATABASE IF NOT EXISTS waitqueue CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;"

mysql -h 127.0.0.1 -u root -p waitqueue < wait-queue/sql/V2__init_schema.sql
mysql -h 127.0.0.1 -u root -p waitqueue < wait-queue/sql/V3__normalize_queue_schema.sql
```

`V2` 创建基础表，`V3` 统一字段长度、二进制排序规则和 `namespace + url` 唯一约束。已有部署只执行尚未应用的迁移；如果历史数据存在重复队列，`V3` 会失败，应先清理重复行。`U2__init_schema.sql` 会删除 queue 表，不属于正常启动流程。

### 2. 配置并构建后端

```bash
cp wait-queue/.env.example wait-queue/.env
corepack pnpm --dir wait-queue build
```

默认配置可直接连接本机 `waitqueue` 数据库和 Redis；非默认账号、端口或密码请修改 `wait-queue/.env`。

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
curl -X POST http://127.0.0.1:3000/waitqueue/queue/newQueue \
  -H 'Content-Type: application/json' \
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
| 后端测试 | `corepack pnpm --dir wait-queue test` |
| 后端启动 | `corepack pnpm --dir wait-queue start` |
| 控制台开发 | `corepack pnpm --dir admin-dashboard dev` |
| 控制台类型检查 | `corepack pnpm --dir admin-dashboard typecheck` |
| 控制台生产构建 | `corepack pnpm --dir admin-dashboard build` |
| 控制台生产启动 | `corepack pnpm --dir admin-dashboard start` |

`wait-queue test` 会先重新编译，再使用 Node.js 内置 test runner 执行全部契约测试。

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

端口和超时必须为正整数。cron 使用“秒 分 时 日 月 周”六段格式。

### 控制台

配置文件示例位于 `admin-dashboard/.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WAITQUEUE_API_URL` | `http://127.0.0.1:3000` | Next.js 服务端代理的后端地址 |

生产环境应在 `build` 和 `start` 阶段提供一致的值。这个变量只在 Next.js 服务端使用，不会打进浏览器代码。

## HTTP API

所有路径都以 `/waitqueue` 开头，请求和响应使用 JSON。成功响应统一为：

```json
{
  "code": 0,
  "msg": "success",
  "data": {}
}
```

参数错误返回 HTTP 400，资源不存在返回 404，不支持的方法返回 405，未处理异常返回 500。调用方应同时判断 HTTP 状态码和响应体 `code`。

### 健康检查

`GET /waitqueue/health`

```json
{
  "code": 0,
  "msg": "success",
  "data": { "status": "ok" }
}
```

这是廉价存活探测。进程仅在启动时完成 MySQL、Redis 就绪检查；它不是每次请求都探测依赖的 deep health。

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
- Waiting → Running → Released 调度轨道；
- 队列搜索、并发占用和三类 cron 展示；
- 注册/更新队列、向指定队列提交任务；
- 浅色/深色主题与移动端布局；
- 离线、过期、加载和空数据状态。

浏览器只请求当前控制台域名；Next.js 根据 `WAITQUEUE_API_URL` 代理 API，因此后端无需 CORS。页面不伪造历史趋势、成功率或平均耗时，因为当前存储模型没有这些数据。

更多前端说明见 [admin-dashboard/README.md](admin-dashboard/README.md)。

## 已知边界

- 所有 API 当前都没有鉴权；只应暴露在可信网络中，并由网关补充认证、授权与限流。
- `hookUrl` 会被服务端主动请求。开放注册能力前必须增加主机/网段白名单，防范 SSRF。
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
