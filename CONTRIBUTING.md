# 开发 JoiAsk Workers 版

使用 Node.js 24，在仓库根目录执行 `npm ci`，安装 Worker、前台、管理后台、文档和测试工具所需的依赖。在同一目录执行 `npm run build` 即可生成完整部署产物。Worker 服务端代码位于 `dist/server/`，静态资源位于 `dist/client/`，其中 `admin/` 包含后台页面和 Monaco 编辑器，`docs/` 包含文档站点。

## 本地运行

在根目录按 `.dev.vars.example` 准备本地 `.dev.vars`，为 `SESSION_SECRET` 和 `SETTINGS_KEY` 各填写一个至少 32 字节的随机值。执行 `npm run dev` 构建站点、应用本地 D1 迁移并启动 Wrangler。Worker 日志会显示本机地址，后台在 `/admin/`，文档在 `/docs/`。要创建本地超级管理员，在 PowerShell 7 中执行 `Read-Host -MaskInput '管理员密码' | node cli/admin.ts --local create operator`。开发数据默认保存在 `.wrangler/state`。

前台使用 vinext 服务端渲染，后台与文档在构建时导出。Worker 在同一入口处理 HTTP 请求、队列和定时维护，用 Durable Object 协调站点的在线连接。业务表结构通过 `migrations/` 下的有序 SQL 文件变更。更新绑定后执行 `npx wrangler types --include-runtime=false worker/bindings.d.ts` 并提交类型变化。

## 运行检查

SMTP 集成测试会使用 OpenSSL 临时签发本地测试证书。Linux 和 macOS 可使用命令行的 `openssl`，Windows 也支持 Git for Windows 附带的 OpenSSL。

```sh
npm run typecheck:worker
npm run test:e2e:typecheck
npm test
npm run build
npm run check:deploy
npm --prefix docs test
npx playwright install chromium
npm run test:e2e
```

浏览器测试启动独立的本地 Worker，从空库创建一次性管理员。测试使用临时资源，不读开发数据库。SMTP、签名读取和模型审核的自动化检查使用可控服务。站长在自己的 Cloudflare 环境完成真实主页读取和邮件送达验收。

发布与运维见[快速开始](docs/content/guide/quick-start.mdx)及[管理员指南](docs/content/guide/administrators.mdx)。

## 从 main 迁移到 Workers 的计划

本分支以 `main@1591dfb` 为起点。安装范围为空 D1 和空 R2，旧站数据保留在原部署。

1. 用 vinext 检查前台兼容性，将前台 SSR、后台和文档构建到同一 Worker。通过首页 HTML 验证站点标题、图标和自定义 CSS。
2. 按版本应用 D1 迁移，将用户、权限、投稿及审核迁入 Worker。用 R2 保存附件，用 Durable Object 广播实时事件。通过 CLI 在新库中创建首个管理员。
3. 将注册切换到公开个性签名验证，为邮件和模型审核接入通用 SMTP 与 Chat Completions。使用本地可控服务验证重试、并发和凭据处理。
4. 用实际构建产物跑浏览器回归，检查部署预演，然后移除 Go、Caddy、Docker 及独立镜像发布链。公开分支后再验证部署按钮、真实 B 站签名可见时间和目标 SMTP 的出口连通性。
