/**
 * File serving endpoint: /f/{hash}/{filename}
 * - Public files: served directly, no auth required
 * - Private files: 403 Forbidden
 *
 * Cache strategy per MIME type:
 *   immutable  (images, video, audio, fonts, JS, CSS) → max-age=31536000, immutable
 *   revalidate (HTML, XML, JSON, text)                → max-age=0, must-revalidate
 *   default    (binary, archives, etc.)               → max-age=86400
 *
 * ETag = "{hash}" (the hash is already a stable content fingerprint).
 * Supports If-None-Match → 304.
 * Supports If-Modified-Since / Last-Modified via uploadedAt → 304.
 * On a 304 hit the file body is never fetched from KV, saving a read.
 */

// ---------- Cache-Control policy ----------

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0, must-revalidate';
const DEFAULT_CC = 'public, max-age=86400';

/**
 * @param {string} mimeType
 * @returns {string} Cache-Control header value
 */
function cacheControl(mimeType) {
  const m = (mimeType || '').toLowerCase().split(';')[0].trim();

  // Immutable assets — content addressed by hash in URL, never changes
  if (
    m.startsWith('image/')  ||
    m.startsWith('video/')  ||
    m.startsWith('audio/')  ||
    m.startsWith('font/')   ||
    m === 'text/css'        ||
    m === 'text/javascript' ||
    m === 'application/javascript' ||
    m === 'application/x-javascript' ||
    // WASM, source maps, etc.
    m === 'application/wasm' ||
    m === 'application/octet-stream'
  ) {
    return IMMUTABLE;
  }

  // Revalidate — content that clients should always check freshness of
  if (
    m === 'text/html'             ||
    m === 'application/xhtml+xml' ||
    m === 'text/xml'              ||
    m === 'application/xml'       ||
    m === 'application/json'      ||
    m === 'application/ld+json'   ||
    m === 'text/plain'            ||
    m === 'text/csv'
  ) {
    return REVALIDATE;
  }

  // Everything else (PDFs, archives, binaries, …)
  return DEFAULT_CC;
}

// ---------- Conditional request helpers ----------

/**
 * Returns true when the client already has a fresh copy (→ respond 304).
 */
function isCached(request, etag, lastModified) {
  // Strong ETag check: If-None-Match
  const inm = request.headers.get('If-None-Match');
  if (inm) {
    // inm may be a comma-separated list or "*"
    if (inm === '*') return true;
    const tags = inm.split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (tags.includes(etag)) return true;
  }

  // Date check: If-Modified-Since (only used when no ETag match attempted)
  if (!inm && lastModified) {
    const ims = request.headers.get('If-Modified-Since');
    if (ims) {
      const imsDate = new Date(ims);
      const lmDate  = new Date(lastModified);
      if (!isNaN(imsDate) && !isNaN(lmDate) && lmDate <= imsDate) return true;
    }
  }

  return false;
}

// ---------- Handler ----------

export async function onRequestGet({ params, request }) {
  const pathStr = Array.isArray(params.path)
    ? params.path.join('/')
    : params.path || '';

  if (!pathStr) {
    return new Response('Not Found', { status: 404 });
  }

  // Extract hash — first segment of /f/{hash}/{filename}
  const slashIdx = pathStr.indexOf('/');
  const hash = slashIdx === -1 ? pathStr : pathStr.slice(0, slashIdx);

  if (!hash) {
    return new Response('Not Found', { status: 404 });
  }

  // Always read metadata first (cheap); skip file body on cache hit
  const meta = await KV.get(`meta_${hash}`, { type: 'json' });

  if (!meta) {
    return new Response('File Not Found', { status: 404 });
  }

  if (!meta.isPublic) {
    return new Response('Forbidden — this file is private', { status: 403 });
  }

  const etag         = `"${hash}"`;
  const lastModified = meta.uploadedAt
    ? new Date(meta.uploadedAt).toUTCString()
    : null;
  const cc           = cacheControl(meta.mimeType);

  // Build the shared headers used for both 200 and 304
  const baseHeaders = {
    'ETag':          etag,
    'Cache-Control': cc,
    'Vary':          'Accept-Encoding',
    ...(lastModified ? { 'Last-Modified': lastModified } : {}),
  };

  // 304 — client already has this version; no body, no KV file read
  if (isCached(request, etag, lastModified)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  // Fetch the actual file bytes
  const fileData = await KV.get(`file_${hash}`, { type: 'arrayBuffer' });

  if (!fileData) {
    return new Response('File Not Found', { status: 404 });
  }

  return new Response(fileData, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Type':        meta.mimeType || 'application/octet-stream',
      'Content-Disposition': contentDisposition(meta.filename),
      'Content-Length':      String(meta.size),
    },
  });
}

// RFC 6266 / RFC 5987: provide an ASCII fallback and a UTF-8 encoded variant.
// The fallback strips non-ASCII and any control/quote characters that would
// break the header or allow CRLF injection from an attacker-controlled name.
function contentDisposition(filename) {
  const name = String(filename || 'file');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()]/g, escape);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
