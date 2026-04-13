# FileVault

[English](./README.en.md) | 中文

一个部署在 EdgeOne Pages 上的轻量级文件托管服务。所有存储逻辑（文件内容 + 元数据）均通过 **EdgeOne Pages KV** 实现，无需额外数据库或对象存储。

## 功能特性

- **文件上传**：支持拖拽或点击选择，多文件队列上传，单文件最大 20 MB
- **文件管理**：列出所有文件、查看 MIME 类型/大小/上传时间、删除文件
- **存储统计**：实时显示已用空间与总配额（1 GB），可视化进度条
- **公开 / 私有**：上传后默认**私有**，可随时切换；切为私有时旧分享链接立即失效（返回 404）
- **直链复制**：文件设为公开后，一键复制可分享的直链
- **鉴权保护**：除公开文件下载外，所有操作均需 HTTP Basic Auth
- **Share Token 轮换**：每次 私有→公开 均生成新 shareId，确保旧链接永久失效

## 目录结构

```
├── edge-functions/
│   ├── f/
│   │   └── [[path]].js       # 文件下载端点（公开文件无需鉴权，以 shareId 寻址）
│   └── api/
│       └── [[default]].js    # REST API（所有路由需 Basic Auth）
├── public/
│   └── index.html            # 管理后台静态页（API 调用触发 Basic Auth）
└── edgeone.json              # EdgeOne Pages 配置（outputDirectory: "public"）
```

管理后台是一个静态 HTML 页面，本身不受 Basic Auth 保护；页面内向 `/api/*` 发起的请求会收到 `401 WWW-Authenticate: Basic`，浏览器弹出登录框后凭据被自动附加。

## 缓存策略

文件下载端点根据 MIME 类型自动设置 `Cache-Control`，并支持 ETag / 304 协商缓存。

| 类型 | 代表格式 | Cache-Control |
|---|---|---|
| **immutable** | 图片、视频、音频、字体、CSS、JS、WASM、二进制流 | `public, max-age=31536000, immutable, no-transform` |
| **revalidate** | HTML、JSON、XML、纯文本、CSV | `public, no-cache, must-revalidate` |
| **default** | PDF、压缩包及其他文件 | `public, max-age=86400, no-transform` |

**ETag**：取值为 `"{shareId}"`。shareId 在每次 私有→公开 时重新生成，因此 ETag 天然与内容版本绑定。客户端携带 `If-None-Match` 时命中则直接返回 **304**，无需读取 KV 中的文件内容。同时支持 `If-Modified-Since` / `Last-Modified` 协商（以文件上传时间为基准）。

## 部署

### 1. 创建 KV 命名空间

在 [EdgeOne Pages 控制台](https://edgeone.ai) 中：

1. 进入 **KV 存储** → 点击 **创建命名空间**，填写名称后确认创建
2. 进入你的 **项目** → **KV 存储** → **绑定命名空间**
3. 绑定时将**变量名**填写为 `KV`（必须与代码一致）

### 2. 配置环境变量

在项目 **设置 → 环境变量** 中添加以下两个变量：

| 变量名 | 说明 |
|---|---|
| `AUTH_USERNAME` | 管理员用户名 |
| `AUTH_PASSWORD` | 管理员密码 |

### 3. 推送代码并部署

将本仓库连接到 EdgeOne Pages 项目后推送，平台会自动识别 `edge-functions/` 目录并完成部署，无需额外构建命令。

## 路由说明

| 路径 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/` | GET | 无（静态页）| 管理后台 UI，加载后调用受保护的 `/api/*` |
| `/f/:shareId/:filename` | GET | 无（公开文件）| 文件下载 / 预览，shareId 失效则返回 404 |
| `/api/files` | GET | Basic Auth | 列出所有文件及存储统计 |
| `/api/upload` | POST | Basic Auth | 上传文件 |
| `/api/files/:hash` | DELETE | Basic Auth | 删除文件 |
| `/api/files/:hash` | PATCH | Basic Auth | 切换公开 / 私有 |

## KV 数据结构

每个文件在 KV 中最多存储三条记录：

| Key | Value | 说明 |
|---|---|---|
| `meta_{hash}` | JSON 字符串 | 文件元数据（含 shareId，仅公开时存在）|
| `file_{hash}` | ArrayBuffer | 文件原始内容 |
| `share_{shareId}` | hash 字符串 | shareId → 内部 hash 的反向索引（仅公开时存在）|

> KV key 只允许 `[A-Za-z0-9_]`，因此使用下划线 `_` 作为分隔符。

元数据 JSON 结构：

```json
{
  "hash": "a3f8c2...",
  "filename": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 1048576,
  "uploadedAt": "2026-04-11T10:00:00.000Z",
  "isPublic": true,
  "shareId": "d9e1b4..."
}
```

> `shareId` 仅在 `isPublic: true` 时存在。文件设为私有时该字段会被删除，对应的 `share_{shareId}` 记录也会同步删除。

## 限制说明

| 项目 | 限制 |
|---|---|
| 单文件大小 | 20 MB |
| 总存储容量 | 1 GB |
| KV 命名空间数 | 1 个（绑定为 `KV`）|
| 文件 URL 格式 | `/f/{shareId}/{原始文件名}` |
| 上传后默认可见性 | 私有 |

## 可见性说明

- **私有（默认）**：文件的 `share_{shareId}` 记录不存在，访问 URL 返回 `404 Not Found`，无法被任何人访问，无法复制分享链接
- **公开**：生成新的 shareId 并写入 `share_{shareId}` → hash 映射，文件 URL 可直接访问和分享，支持 CDN 长期缓存

切换为私有后，`share_{shareId}` 记录立即删除，**原有的公开链接立即失效**，无需手动处理缓存或 URL。再次切回公开时会生成全新的 shareId，旧链接**永久**无法恢复。

## 本地调试

可使用 [EdgeOne CLI](https://pages.edgeone.ai/zh/document/edgeone-cli) 在本地启动调试环境：

```bash
npm install -g edgeone
edgeone pages dev
```

> 注意：本地调试环境中 KV 为模拟实现，行为可能与线上存在差异。
