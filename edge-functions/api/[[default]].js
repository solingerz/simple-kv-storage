/**
 * API routes — all require Basic Auth.
 *
 * GET    /api/files              → list all files + storage stats
 * POST   /api/upload             → upload a file (multipart/form-data, field "file")
 * DELETE /api/files/:hash        → delete a file
 * PATCH  /api/files/:hash        → toggle public/private visibility
 *
 * KV key schema:
 *   meta:{hash}  → JSON: { hash, filename, mimeType, size, uploadedAt, isPublic }
 *   file:{hash}  → ArrayBuffer (raw file bytes)
 *
 * Environment variables:
 *   KV             — bound KV namespace
 *   AUTH_USERNAME  — admin username
 *   AUTH_PASSWORD  — admin password
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

async function handleList(kv) {
  const files = [];
  let cursor;
  let result;

  do {
    const opts = { prefix: 'meta:', limit: 256 };
    if (cursor) opts.cursor = cursor;
    result = await kv.list(opts);
    cursor = result.cursor;

    for (const keyObj of result.keys) {
      const meta = await kv.get(keyObj.key, { type: 'json' });
      if (meta) files.push(meta);
    }
  } while (result && !result.complete);

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
  let cursor;
  let result;
  let usedSize = 0;
  do {
    const opts = { prefix: 'meta:', limit: 256 };
    if (cursor) opts.cursor = cursor;
    result = await kv.list(opts);
    cursor = result.cursor;
    for (const keyObj of result.keys) {
      const meta = await kv.get(keyObj.key, { type: 'json' });
      if (meta) usedSize += meta.size || 0;
    }
  } while (result && !result.complete);

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

  await kv.put(`file:${hash}`, buffer);
  await kv.put(`meta:${hash}`, JSON.stringify(meta));

  return json({ success: true, file: meta }, 201);
}

async function handleDelete(hash, kv) {
  const meta = await kv.get(`meta:${hash}`, { type: 'json' });
  if (!meta) {
    return json({ error: 'File not found' }, 404);
  }

  await kv.delete(`file:${hash}`);
  await kv.delete(`meta:${hash}`);

  return json({ success: true });
}

async function handleToggleVisibility(hash, kv) {
  const meta = await kv.get(`meta:${hash}`, { type: 'json' });
  if (!meta) {
    return json({ error: 'File not found' }, 404);
  }

  meta.isPublic = !meta.isPublic;
  await kv.put(`meta:${hash}`, JSON.stringify(meta));

  return json({ success: true, file: meta });
}

// ---------- Router ----------

export async function onRequest({ request, env }) {
  if (!checkAuth(request, env)) {
    return unauthorizedResponse();
  }

  const kv = env.KV;
  if (!kv) {
    return json({ error: 'KV namespace not configured' }, 500);
  }

  const url = new URL(request.url);
  const pathname = url.pathname; // e.g. /api/files, /api/files/abc123
  const method = request.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    });
  }

  // GET /api/files
  if (method === 'GET' && pathname === '/api/files') {
    return handleList(kv);
  }

  // POST /api/upload
  if (method === 'POST' && pathname === '/api/upload') {
    return handleUpload(request, kv);
  }

  // DELETE /api/files/:hash  or  PATCH /api/files/:hash
  const fileMatch = pathname.match(/^\/api\/files\/([0-9a-f]{32})$/);
  if (fileMatch) {
    const hash = fileMatch[1];
    if (method === 'DELETE') return handleDelete(hash, kv);
    if (method === 'PATCH') return handleToggleVisibility(hash, kv);
  }

  return json({ error: 'Not Found' }, 404);
}
