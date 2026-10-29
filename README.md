# MONO Storage

一个基于 Cloudflare Workers 和 R2 的对象存储控制台，支持网页文件管理、HTTP API 和 MCP。

## 安装说明

### 准备环境

- Git、Node.js 22.12 或更高版本，推荐 Node.js 24 LTS。
- 部署到 Cloudflare 时，需要 Cloudflare 账户并开通 R2。

获取源码并安装依赖：

```bash
git clone https://github.com/yowiv08/MONO-Storage.git
cd MONO-Storage
npm ci
```

### 本地运行

```bash
npm run dev
```

打开 `http://127.0.0.1:5173`，按首次安装向导填写控制台名称、后台路径和管理员密钥。管理员密钥可自行设置，也可自动生成。

本地运行使用本机存储，文件和配置保存在 `.wrangler/state`。首次安装无需安装密钥；安装完成后，初始化入口锁定，不能再次安装或覆盖已有配置。之后通过设置的后台路径登录。

### 部署到 Cloudflare

登录 Cloudflare 并创建 R2 存储桶：

```bash
npx wrangler login
npx wrangler r2 bucket create mono-storage
```

`wrangler.toml` 中的 `name` 是 Worker 名称，`bucket_name` 是 R2 桶名称。若使用其他桶名称，请同步修改 `bucket_name`；`STORAGE_BUCKETS` 中的 `binding` 必须与 R2 绑定一致。

设置会话签名密钥，在提示中输入至少 32 个字符的随机值：

```bash
npx wrangler secret put SESSION_SECRET
```

首次配置时，如果 Wrangler 提示创建 Worker，确认创建后继续输入密钥。

`SESSION_SECRET` 用于会话和临时凭证签名，与安装时设置的管理员密钥分别配置。`.dev.vars` 仅用于本地运行；部署到 Cloudflare 时不要设置 `LOCAL_DEVELOPMENT`。

发布应用：

```bash
npm run deploy
```

打开命令返回的网站地址，完成首次安装。保存管理员密钥和后台路径；安装完成后，网站根页面用于公开分享文件，管理操作通过设置的后台路径进入。

默认使用 Cloudflare 提供的 `workers.dev` 地址。如需自定义域名，将 `wrangler.toml` 顶层的 `workers_dev` 改为 `false`，添加 `routes`，把示例域名替换为 Cloudflare 账户中的域名，然后重新运行 `npm run deploy`：

```toml
workers_dev = false
routes = [{ pattern = "storage.example.com", custom_domain = true, zone_name = "example.com" }]
```

如需多个存储桶，在 `wrangler.toml` 增加 R2 绑定，并将对应名称和绑定加入 `STORAGE_BUCKETS`；配置列表中的第一个桶保存系统配置。

## 功能说明

- **文件管理**：上传文件、上传文件夹、拖拽上传、大文件分片上传，支持下载、批量删除、自定义元数据和同名覆盖确认。
- **目录浏览**：新建文件夹、删除空目录、面包屑导航、路径前缀搜索、类型筛选、排序，以及列表和网格视图。
- **目录统计**：顶部文件数量与总大小随当前目录更新，包含该目录的所有子目录；返回“全部文件”显示整个存储桶。搜索、筛选和列表分页不改变统计范围。
- **在线预览**：图片、文本、PDF、音频和视频预览，支持 HTTP Range 范围读取。
- **文件分享**：为单个文件生成公开链接，可设 1 小时、1 天、7 天、30 天或长期有效，并可随时取消。文件被覆盖、删除或链接失效后，原链接不可继续访问。
- **分享链接总览**：工作空间集中查看有效分享、对应文件、存储桶、大小和有效期，支持复制链接、打开文件和取消分享。
- **后台设置**：在侧栏底部的“设置”修改工作空间名称、后台路径和管理员密钥，管理 API Token。更换管理员密钥会使旧登录、API Token 和分享链接失效。
- **登录限速**：后台可设置每个来源 IP 的最大登录尝试次数和连续时间窗口。默认 10 次 / 60 秒，支持 1–100 次、10–3600 秒；成功和失败均计数，超限时显示等待倒计时。
- **API Token**：支持自动生成或自定义密钥、有效期、权限编辑、停用和撤销，可限定全部存储桶、单个桶或精确单个文件。
- **文件专用 Token**：在文件菜单或预览窗口创建，只能查看和操作绑定的完整文件路径，同目录的其他文件不在授权范围内。
- **HTTP API**：通过 Bearer Token 调用文件列表、统计、信息、读写、目录和分享接口，后台提供调用示例。
- **MCP 接入**：提供远程 Streamable HTTP 端点 `/mcp`，让 AI 按 Token 的范围和权限操作文件，支持查询、读取、写入、分片、目录及分享工具。后台“API 访问”提供连接地址、客户端配置和可下载的 AI 调用说明。
- **界面与访问**：支持白天和黑夜模式、可点击导航、帮助说明，以及独立后台入口。R2 桶保持私有，公开分享通过链接访问。

API Token 可选择只读、只写、读写、ALL，或逐项授权：

| 权限 | 功能 |
| --- | --- |
| `read` | 查询列表、统计、文件信息，预览和下载 |
| `write` | 上传、覆盖与分片上传 |
| `delete` | 删除文件与批量删除 |
| `create_folder` | 创建目录 |
| `delete_folder` | 删除空目录 |
| `share` | 查询和取消分享；创建分享同时需要 `read` |

ALL 包含所选范围内的全部存储操作。单文件 Token 支持读取、写入、删除和分享，不授予目录操作或后台管理权限。MCP 使用独立 API Token 连接，并按权限提供对应工具。
