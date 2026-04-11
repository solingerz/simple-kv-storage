/**
 * API routes — all require Basic Auth.
 *
 * GET    /api/files              → list all files + storage stats
 * POST   /api/upload             → upload a file (multipart/form-data, field "file")
 * DELETE /api/files/:hash        → delete a file
 * PATCH  /api/files/:hash        → toggle public/private visibility
 *
 * KV key schema (EdgeOne KV only allows [A-Za-z0-9_] in keys):
 *   meta_{hash}  → JSON: { hash, filename, mimeType, size, uploadedAt, isPublic }
 *   file_{hash}  → ArrayBuffer (raw file bytes)
 *
 * Globals / environment:
 *   KV             — EdgeOne KV namespace (global binding)
 *   AUTH_USERNAME  — admin username (env var)
 *   AUTH_PASSWORD  — admin password (env var)
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024;       // 20 MB
const MAX_TOTAL_SIZE = 1 * 1024 * 1024 * 1024; // 1 GB

// ---------- Auth ----------

function checkAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(':');
    if (sep === -1) return false;
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    return user === env.AUTH_USERNAME && pass === env.AUTH_PASSWORD;
  } catch {
    return false;
  }
}

function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="File Storage"',
      'Content-Type': 'application/json',
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- Random hash ----------

function generateHash() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------- Handlers ----------

async function getMeta(kv, hash) {
  const raw = await kv.get(`meta_${hash}`);
  return raw ? JSON.parse(raw) : null;
}

async function listAllMeta(kv) {
  const files = [];
  let cursor = '';
  let complete = false;

  while (!complete) {
    const opts = { prefix: 'meta_', limit: 256 };
    if (cursor) opts.cursor = cursor;
    const page = await kv.list(opts);
    const keys = Array.isArray(page?.keys) ? page.keys : [];

    for (const keyObj of keys) {
      const raw = await kv.get(keyObj.key);
      if (raw) {
        try { files.push(JSON.parse(raw)); } catch {}
      }
    }

    if (page?.cursor) {
      cursor = page.cursor;
    } else if (keys.length > 0) {
      cursor = keys[keys.length - 1].key;
    }
    complete = Boolean(page?.complete) || keys.length === 0;
  }

  return files;
}

async function handleList(kv) {
  const files = await listAllMeta(kv);
  const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
  return json({ files, totalSize, maxTotalSize: MAX_TOTAL_SIZE });
}

async function handleUpload(request, kv) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'Invalid form data' }, 400);
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'No file provided' }, 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return json(
      { error: `File too large. Maximum allowed size is ${MAX_FILE_SIZE / 1024 / 1024} MB` },
      413
    );
  }

  // Check total storage
  const existing = await listAllMeta(kv);
  const usedSize = existing.reduce((acc, f) => acc + (f.size || 0), 0);

  if (usedSize + file.size > MAX_TOTAL_SIZE) {
    return json(
      { error: 'Storage quota exceeded. Total storage limit is 1 GB.' },
      413
    );
  }

  const hash = generateHash();
  const buffer = await file.arrayBuffer();

  const meta = {
    hash,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    uploadedAt: new Date().toISOString(),
    isPublic: false,
  };

  await kv.put(`file_${hash}`, buffer);
  await kv.put(`meta_${hash}`, JSON.stringify(meta));

  return json({ success: true, file: meta }, 201);
}

async function handleDelete(hash, kv) {
  const meta = await getMeta(kv, hash);
  if (!meta) {
    return json({ error: 'File not found' }, 404);
  }

  await kv.delete(`file_${hash}`);
  await kv.delete(`meta_${hash}`);

  return json({ success: true });
}

async function handleToggleVisibility(hash, kv) {
  const meta = await getMeta(kv, hash);
  if (!meta) {
    return json({ error: 'File not found' }, 404);
  }

  meta.isPublic = !meta.isPublic;
  await kv.put(`meta_${hash}`, JSON.stringify(meta));

  return json({ success: true, file: meta });
}

// ---------- Router ----------

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (!checkAuth(request, env)) {
      return unauthorizedResponse();
    }

    if (typeof KV === 'undefined') {
      return json(
        { error: 'KV binding not found. Bind a KV namespace with variable name "KV" in EdgeOne Pages settings.' },
        500
      );
    }

    // GET /api/files
    if (method === 'GET' && pathname === '/api/files') {
      return await handleList(KV);
    }

    // POST /api/upload
    if (method === 'POST' && pathname === '/api/upload') {
      return await handleUpload(request, KV);
    }

    // DELETE /api/files/:hash  or  PATCH /api/files/:hash
    const fileMatch = pathname.match(/^\/api\/files\/([0-9a-f]{32})$/);
    if (fileMatch) {
      const hash = fileMatch[1];
      if (method === 'DELETE') return await handleDelete(hash, KV);
      if (method === 'PATCH') return await handleToggleVisibility(hash, KV);
    }

    return json({ error: 'Not Found' }, 404);
  } catch (err) {
    return json(
      { error: err && err.message ? err.message : String(err), stack: err && err.stack },
      500
    );
  }
}
