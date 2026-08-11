# WaitQueue 队列运行中心

waitqueue.js 的轻量实时运维控制台。它直接读取后端队列配置、Redis 运行快照和当前进程计数，不使用 mock 数据，也不展示当前系统无法证明的历史趋势。

界面遵循 [fullstack-ai-infra/design-system@9d048faa](https://github.com/fullstack-ai-infra/design-system/tree/9d048faaabe0429a6a8720bfbb31418544237b6b) 的 **Warm Agent Workspace** 视觉契约：暖象牙画布、stone 导航、paper 表面、charcoal 文字和 sage 主操作。布局采用 72px 模块栏、256px 队列上下文栏和 60px 顶栏；表格、表单、抽屉、弹窗及反馈继续由 Ant Design 6 提供。

设计系统当前尚未发布稳定 npm 版本，且其 React 18 peer contract 与本项目 React 19 不兼容，因此这里使用轻量 semantic adapter 将上游 token 映射到 Ant Design `ConfigProvider`，不引入重复的 Radix、Tailwind 或状态管理运行时。待设计系统正式支持 React 19 后，可直接切换到包依赖。

## 页面怎么用

左侧模块栏的四个页面分别承担不同职责：

1. **总览**：先看等待任务、最老等待、运行容量、Retry、DLQ，以及本进程 callback/claim/recovery 计数。计数的起始时间显示在卡片底部，服务重启后会归零。
2. **队列**：在上下文目录搜索 namespace、回调 origin 或 queue ID；点选队列后查看运行槽位、Cron 和真实运行状态，也可提交 taskId 或更新配置。
3. **死信**：选择队列后分页查看 DLQ；重放前必须二次确认，后端用 `entryId` 校验 generation，避免把已更新的旧记录误重放。
4. **诊断**：分别查看进程 liveness、MySQL/Redis readiness，并核对 Prometheus 抓取契约。

页面每 10 秒自动刷新，浏览器切到后台时暂停；手动刷新会同时更新队列快照和健康状态。顶栏只有在 liveness 与 readiness 都成功时才显示“服务在线”，依赖异常会显示“依赖异常”。桌面端使用模块栏、固定队列目录和表格，窄屏隐藏目录并通过抽屉选择队列，表格自动切换为卡片；浅色/深色主题共用同一套语义 token。

当前没有任务历史存储，因此页面不会展示吞吐趋势、成功率、平均耗时或任务明细。

## 最快启动（推荐）

先在仓库根目录按 [根 README](../README.md) 创建 `.env`，然后运行：

```bash
docker compose up --build --detach --wait
```

访问 [http://127.0.0.1:3001](http://127.0.0.1:3001)。API 默认位于 [http://127.0.0.1:3000](http://127.0.0.1:3000)，Compose 会在服务就绪后才把控制台标记为可用。停止环境使用：

```bash
docker compose down
```

## 本地开发

前置条件：

- Node.js `>= 20.9`；
- Corepack / pnpm 8；
- 已在 `http://127.0.0.1:3000` 启动 wait-queue 后端。

从仓库根目录执行：

```bash
corepack enable
corepack pnpm --dir admin-dashboard install --frozen-lockfile
cp admin-dashboard/.env.example admin-dashboard/.env.local
corepack pnpm --dir admin-dashboard dev
```

访问 [http://127.0.0.1:3001](http://127.0.0.1:3001)。

如果后端不在默认地址，修改 `admin-dashboard/.env.local`：

```dotenv
WAITQUEUE_API_URL=http://127.0.0.1:3000
WAITQUEUE_API_TOKEN=
DASHBOARD_ALLOWED_HOSTS=127.0.0.1,localhost,[::1]
```

后端开启 `WAITQUEUE_API_TOKEN` 时，这里必须填写同一值。该值是服务端共享凭据，不要改名为 `NEXT_PUBLIC_*`。`DASHBOARD_ALLOWED_HOSTS` 是无通配符的精确 hostname 列表，比较时忽略端口；使用共享域名或反向代理时必须加入外部 hostname，并让代理保留/改写为该 Host。

## 生产构建

```bash
corepack pnpm --dir admin-dashboard typecheck
corepack pnpm --dir admin-dashboard check:design
corepack pnpm --dir admin-dashboard build
corepack pnpm --dir admin-dashboard start
```

`dev` 和 `start` 都固定监听 3001，避免与后端默认的 3000 冲突。`WAITQUEUE_API_URL`、`WAITQUEUE_API_TOKEN` 和 `DASHBOARD_ALLOWED_HOSTS` 在服务启动后按请求读取，无需作为 Docker build argument；同一份构建产物可在不同环境复用。

### Docker Compose 运行模型

仓库根目录的 Compose 会把控制台构建为 Next.js standalone 镜像，并在运行时将 API 代理指向容器网络中的 `http://api:3000`：

```bash
docker compose up --build --detach --wait
```

启动完成后访问 [http://127.0.0.1:3001](http://127.0.0.1:3001)。Compose 将同一个 `WAITQUEUE_API_TOKEN` 仅注入 API 与控制台运行时，不会写入镜像构建层。控制台镜像以非 root 用户和只读文件系统运行。

## 数据链路

```text
Browser
  └─ /waitqueue/*（同源）
       └─ Next.js internal rewrite
            └─ /api/waitqueue/*（服务端白名单代理）
                 └─ WAITQUEUE_API_URL + 服务端 Bearer token
                      ├─ GET  /waitqueue/health/live（控制台代理）
                      ├─ GET  /waitqueue/health/ready（控制台代理）
                      ├─ GET  /waitqueue/admin/overview
                      ├─ GET  /waitqueue/admin/deadLetters
                      ├─ POST /waitqueue/admin/deadLetters/replay
                      ├─ POST /waitqueue/queue/newQueue
                      └─ POST /waitqueue/scheduler/addTask
```

代理先用 `DASHBOARD_ALLOWED_HOSTS` 精确校验请求 Host，再只接受上图列出的 method/path；死信查询只重建 `queueId`、`offset`、`limit` 三个 query 参数，POST 只接受 JSON 且限制为 32 KiB。它不转发浏览器传入的 Authorization、Cookie、Host、任意 query 或转发头，禁止上游重定向，只复制必要的响应头。服务端变量不会进入浏览器 bundle；后端无需开启 CORS。Prometheus `/metrics` 刻意不在浏览器代理白名单中，应由采集器直接携带后端 Bearer token 抓取；后端仍保留 `/waitqueue/metrics` 兼容别名。

## 技术与目录

运行时直接依赖只有 Next.js、React、Ant Design、Lucide 图标与 Ant SSR 样式运行时；没有 Ant Design Pro、Redux、Axios、Mock.js、Tailwind、Radix 或图表库。Lucide 与设计系统的图标契约一致，并按组件 tree-shaking。Pages Router 使用 `_document.tsx` 提取 Ant Design CSS-in-JS 样式，避免首屏闪烁；浅色与深色使用独立的 Ant CSS variable scope，避免服务端浅色变量覆盖客户端深色状态。Next 16 的开发与生产构建显式使用 Webpack，以确保 Ant Design 与提取器共享同一个样式上下文；CI 会检查真实 Ant 组件规则、主题隔离和关键暗色文字对比度。

```text
admin-dashboard/
├── src/pages/_app.tsx             # 全局样式与主题入口
├── src/pages/_document.tsx        # Ant Design 服务端样式提取
├── src/pages/index.tsx            # 数据读取、交互与四个运行页面
├── src/pages/api/waitqueue/       # 运行时白名单代理与 token 注入
├── src/style/global.css           # design-system 语义适配与基础样式
├── src/style/dashboard.module.css # Warm Queue Console 布局与响应式样式
├── src/theme/                      # 语义 token 到 Ant Design 的映射
├── next.config.js                 # API 同源代理
└── .env.example                   # 后端地址示例
```

HTTP 使用浏览器原生 `fetch`，页面状态使用 React hooks。后端未持久化任务历史，所以页面明确不伪造吞吐趋势、历史成功率或平均耗时。

## 安全边界

控制台的服务端代理可以隐藏后端共享 token，但它不是用户身份认证。任何能访问控制台的人都能借代理读取或修改队列。部署时必须：

- 将控制台和 API 放到可信网络或认证网关之后；
- 后端与控制台配置同一个高强度 `WAITQUEUE_API_TOKEN`；
- 将控制台外部 hostname 精确加入 `DASHBOARD_ALLOWED_HOSTS`；
- 后端配置精确 `HOOK_URL_ALLOWLIST`，并按需配置出站网络策略；
- 不把管理端直接暴露到公网。

完整启动流程、API 和回调协议见仓库根目录 [README.md](../README.md)。
