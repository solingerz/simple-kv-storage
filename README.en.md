# FileVault

[中文](./README.md) | English

A lightweight file hosting service deployed on EdgeOne Pages. All storage logic (file content + metadata) is handled via **EdgeOne Pages KV** — no external database or object storage required.

## Features

- **File upload**: Drag-and-drop or click to browse, multi-file queue, 20 MB max per file
- **File management**: List all files with MIME type, size, upload time, and delete support
- **Storage stats**: Real-time used/total quota display (1 GB) with a visual progress bar
- **Public / Private**: Files are **private by default**; toggle visibility at any time — switching to private immediately invalidates all previously shared URLs (returns 404)
- **Copy direct link**: One-click copy of a shareable URL once a file is made public
- **Auth protection**: All operations require HTTP Basic Auth, except downloading public files
- **Share token rotation**: Each private→public toggle mints a new `shareId`, permanently breaking old URLs

## Directory Structure

```
├── edge-functions/
│   ├── f/
│   │   └── [[path]].js       # File download endpoint (public files, addressed by shareId)
│   └── api/
│       └── [[default]].js    # REST API (all routes require Basic Auth)
├── public/
│   └── index.html            # Admin UI static page (API calls trigger Basic Auth)
└── edgeone.json              # EdgeOne Pages config (outputDirectory: "public")
```

The admin UI is a static HTML page with no server-side auth guard of its own. Requests it makes to `/api/*` receive `401 WWW-Authenticate: Basic`, prompting the browser's native login dialog, after which credentials are attached automatically.

## Caching Strategy

The file download endpoint sets `Cache-Control` automatically based on MIME type, and supports ETag / 304 conditional caching.

| Category | Example formats | Cache-Control |
|---|---|---|
| **immutable** | Images, video, audio, fonts, CSS, JS, WASM, binary streams | `public, max-age=31536000, immutable, no-transform` |
| **revalidate** | HTML, JSON, XML, plain text, CSV | `public, no-cache, must-revalidate` |
| **default** | PDF, archives, and other files | `public, max-age=86400, no-transform` |

**ETag**: Set to `"{shareId}"`. Because `shareId` is regenerated on each private→public toggle, the ETag is naturally tied to the content version. When a client sends `If-None-Match` and it matches, the server returns **304** without reading the file from KV. `If-Modified-Since` / `Last-Modified` negotiation is also supported (based on the file's upload time).

## Deployment

### 1. Create a KV Namespace

In the [EdgeOne Pages console](https://edgeone.ai):

1. Go to **KV Storage** → click **Create Namespace**, enter a name and confirm
2. Open your **project** → **KV Storage** → **Bind Namespace**
3. Set the **variable name** to `KV` (must match the code)

### 2. Configure Environment Variables

Add the following variables under project **Settings → Environment Variables**:

| Variable | Description |
|---|---|
| `AUTH_USERNAME` | Admin username |
| `AUTH_PASSWORD` | Admin password |

### 3. Push and Deploy

Connect this repository to an EdgeOne Pages project and push. The platform automatically detects the `edge-functions/` directory and deploys — no build command needed.

## Routes

| Path | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | None (static) | Admin UI; loads then calls protected `/api/*` endpoints |
| `/f/:shareId/:filename` | GET | None (public files) | File download / preview; returns 404 if shareId is invalid |
| `/api/files` | GET | Basic Auth | List all files and storage stats |
| `/api/upload` | POST | Basic Auth | Upload a file |
| `/api/files/:hash` | DELETE | Basic Auth | Delete a file |
| `/api/files/:hash` | PATCH | Basic Auth | Toggle public / private |

## KV Data Structure

Each file stores up to three KV records:

| Key | Value | Description |
|---|---|---|
| `meta_{hash}` | JSON string | File metadata (includes `shareId` when public) |
| `file_{hash}` | ArrayBuffer | Raw file bytes |
| `share_{shareId}` | hash string | Reverse index: shareId → internal hash (exists only when public) |

> KV keys only allow `[A-Za-z0-9_]`, so underscores are used as separators.

Metadata JSON structure:

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

> `shareId` is only present when `isPublic: true`. When a file is set to private, the field is removed and the corresponding `share_{shareId}` record is deleted.

## Limits

| Item | Limit |
|---|---|
| Max file size | 20 MB |
| Total storage | 1 GB |
| KV namespaces | 1 (bound as `KV`) |
| File URL format | `/f/{shareId}/{original filename}` |
| Default visibility after upload | Private |

## Visibility Explained

- **Private (default)**: No `share_{shareId}` record exists; accessing the URL returns `404 Not Found`. The file cannot be accessed or shared by anyone.
- **Public**: A new `shareId` is generated and a `share_{shareId}` → hash mapping is written. The file URL is directly accessible and shareable, and supports long-term CDN caching.

When switched back to private, the `share_{shareId}` record is deleted immediately — **existing public URLs stop working at once**, with no cache or URL cleanup needed. Switching back to public generates a brand-new `shareId`; old URLs are **permanently** broken.

## Local Development

Use the [EdgeOne CLI](https://pages.edgeone.ai/en/document/edgeone-cli) to run a local dev environment:

```bash
npm install -g edgeone
edgeone pages dev
```

> Note: The local KV is a simulated implementation and may behave differently from the production environment.
