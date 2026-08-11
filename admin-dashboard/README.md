# WaitQueue Control Room

waitqueue.js 的轻量实时运维控制台。它直接读取后端队列配置与 Redis 实时计数，不使用 mock 数据，也不展示当前系统无法证明的历史指标。

![Control Room](../docs/control-room.jpg)

界面沿用 DWS Backend 的开发者工作台语言：浅色数据目录、紧凑顶栏、黑色 Workbench 横幅、1px 深色描边和薄荷绿运行状态。所有控件均由语义化 HTML 与局部 CSS 实现，不依赖 UI 组件库。

<details>
<summary>移动端预览</summary>

<p align="center"><img src="../docs/control-room-mobile.jpg" alt="WaitQueue 移动端控制台" width="390"></p>

</details>

## 页面能力

- 汇总队列数、waiting、running、capacity 和实时利用率；
- 通过队列目录、Workbench 摘要和容量条表达调度状态；
- 展示各队列回调、并发占用和 run/check/expire cron；
- 搜索队列，注册或更新队列，提交 taskId；
- 每 10 秒自动刷新，页面切到后台时暂停；
- 支持浅色/深色主题、桌面与移动布局；
- 处理 loading、empty、stale 和 offline 状态。

当前没有任务历史存储，因此页面不会展示吞吐趋势、成功率、平均耗时或任务明细。

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
corepack pnpm --dir admin-dashboard build
corepack pnpm --dir admin-dashboard start
```

`dev` 和 `start` 都固定监听 3001，避免与后端默认的 3000 冲突。`WAITQUEUE_API_URL`、`WAITQUEUE_API_TOKEN` 和 `DASHBOARD_ALLOWED_HOSTS` 在服务启动后按请求读取，无需作为 Docker build argument；同一份构建产物可在不同环境复用。

### Docker Compose

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
                      ├─ GET  /waitqueue/admin/overview
                      ├─ GET  /waitqueue/admin/deadLetters
                      ├─ POST /waitqueue/admin/deadLetters/replay
                      ├─ POST /waitqueue/queue/newQueue
                      └─ POST /waitqueue/scheduler/addTask
```

代理先用 `DASHBOARD_ALLOWED_HOSTS` 精确校验请求 Host，再只接受上图五组 method/path；死信查询只重建 `queueId`、`offset`、`limit` 三个 query 参数，POST 只接受 JSON 且限制为 32 KiB。它不转发浏览器传入的 Authorization、Cookie、Host、任意 query 或转发头，禁止上游重定向，只复制必要的响应头。服务端变量不会进入浏览器 bundle；后端无需开启 CORS。

## 技术与目录

运行时只保留三个直接依赖：Next.js、React 和 React DOM。

```text
admin-dashboard/
├── src/pages/_app.tsx             # 全局样式与页面入口
├── src/pages/index.tsx            # 数据读取、交互与控制室页面
├── src/pages/api/waitqueue/       # 运行时白名单代理与 token 注入
├── src/style/global.css           # 设计 token、主题与基础样式
├── src/style/dashboard.module.css # 工作台布局、状态组件和响应式样式
├── next.config.js                 # API 同源代理
└── .env.example                   # 后端地址示例
```

HTTP 使用浏览器原生 `fetch`，页面状态使用 React hooks；没有 Redux、Axios、Mock.js 或图表运行时。

## 安全边界

控制台的服务端代理可以隐藏后端共享 token，但它不是用户身份认证。任何能访问控制台的人都能借代理读取或修改队列。部署时必须：

- 将控制台和 API 放到可信网络或认证网关之后；
- 后端与控制台配置同一个高强度 `WAITQUEUE_API_TOKEN`；
- 将控制台外部 hostname 精确加入 `DASHBOARD_ALLOWED_HOSTS`；
- 后端配置精确 `HOOK_URL_ALLOWLIST`，并按需配置出站网络策略；
- 不把管理端直接暴露到公网。

完整启动流程、API 和回调协议见仓库根目录 [README.md](../README.md)。
