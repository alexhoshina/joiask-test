<p align="center">
  <img src="docs/public/favicon.png" alt="JoiAsk logo" width="128" height="128" />
</p>

<h1 align="center">JoiAsk 提问箱</h1>

<p align="center">
  可自行部署的开源提问箱，方便收集和展示观众提问。<br />
  支持话题分类、图文投稿、内容审核与卡片归档。
</p>

<p align="center">
  <a href="docs/content/guide/quick-start.mdx">Workers 安装指南</a> ·
  <a href="https://ask.vjoi.cn/">在线示例</a>
</p>

> [!IMPORTANT]
> **JoiAsk 属于 PowerLive 项目组。**
>
> 欢迎访问 **[PowerLive 官网 →](https://powerlive.io/)**，了解更多项目。

## 界面预览

<p align="center">
  <img src="docs/public/screenshot.png" alt="JoiAsk 提问箱界面预览" width="960" />
</p>

## Cloudflare 部署

这个分支从空数据库部署 JoiAsk。一个 Worker 提供提问箱、管理后台和文档，D1 保存业务数据，R2 保存图片，Durable Objects 负责实时互动，Queues 负责异步审核。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Falexhoshina%2FJoiAsk%2Ftree%2Fcloudflare-workers)

按钮从 `alexhoshina/JoiAsk` 仓库的 `cloudflare-workers` 分支读取模板。选择账号、D1、R2 和审核队列，然后在同一页面填写以下四项。

| 部署表单字段 | 填写内容 |
| --- | --- |
| `SESSION_SECRET` | 为登录会话生成的随机密钥，至少 32 字节 |
| `SETTINGS_KEY` | 为加密站点设置单独生成的随机密钥，至少 32 字节 |
| `JOIASK_INITIAL_ADMIN_USERNAME` | 自选的首个超级管理员用户名 |
| `JOIASK_INITIAL_ADMIN_PASSWORD` | 该管理员的登录密码 |

将 **Build command** 留空，**Deploy command** 设为 `npm run release`。部署完成后打开站点的 `/admin/`，用表单中设置的用户名和密码登录。首次登录成功时，系统会创建超级管理员账号。

账号创建后，可在 Worker 的 **Settings → Variables and Secrets** 移除两个 `JOIASK_INITIAL_ADMIN_*` 设置，保留两个长期密钥，再点击 **Deploy**。以后继续使用已创建的账号登录。已有账号可通过[管理员 CLI](./docs/content/guide/administrators.mdx) 恢复。

### 在 Cloudflare 控制台设置首个管理员

如果新站部署时尚未填写管理员凭据，进入 **Workers & Pages → 站点对应的 Worker → Settings → Variables and Secrets**。添加 `JOIASK_INITIAL_ADMIN_USERNAME`（Text 或 Secret）和 `JOIASK_INITIAL_ADMIN_PASSWORD`（Secret），点击 **Deploy**，再用这组凭据登录 `/admin/`。

### 命令行部署

使用 Node.js 24。在仓库根目录安装依赖，登录 Cloudflare，并为新站创建资源。以下示例使用 `wrangler.jsonc` 中的默认资源名。

```sh
npm ci
npx wrangler login
npx wrangler d1 create joiask-db --binding DB --update-config
npx wrangler r2 bucket create joiask-files --update-config=false
npx wrangler queues create joiask-moderation
```

Wrangler 会把数据库 ID 写入根目录的 `wrangler.jsonc`。如果要用自选名称，先在配置和创建命令中填好本站的 Worker 与资源名称。首次发布时在私有文件 `.dev.vars.production` 中填写上述两个长期密钥，也可一并填入首个管理员的用户名和密码。

```sh
npm run release -- --secrets-file .dev.vars.production
```

提问箱位于 `/`，管理后台位于 `/admin/`，文档位于 `/docs/`。站长可在后台配置通用 SMTP 和兼容 Chat Completions 的审核服务。会员通过 B 站公开个性签名验证 UID，验证成功即可恢复原签名。

默认从 B 站原生名片接口读取资料。使用自建反代时，超级管理员在后台「设置」填入完整接口地址（例如 `https://bili.example.com/card`），Worker 会自动附上 `mid` 查询参数。[配置说明](./docs/content/guide/configuration.mdx)

后续更新运行 `npm run release`。每个站点使用自己的配置及独立资源。按钮安装的站点使用 Cloudflare 创建的仓库副本进行更新和管理。[完整部署说明](./docs/content/guide/deployment.mdx)

### 本地开发

在根目录按 `.dev.vars.example` 创建 `.dev.vars`，给两个长期密钥填入本地专用随机值，然后运行：

```sh
npm ci
npm run dev
```

本地运行使用独立资源。要单独构建完整站点，在仓库根目录执行 `npm run build`。本地管理员的创建方式见[快速开始](docs/content/guide/quick-start.mdx)，测试命令见[开发指南](CONTRIBUTING.md)。

## 参与开发

- [开发环境与贡献指南](CONTRIBUTING.md)
- [开发指南](docs/content/development.mdx)
- [提交问题或建议](https://github.com/powerlive-io/JoiAsk/issues)

## 许可证

[MIT](LICENSE)
