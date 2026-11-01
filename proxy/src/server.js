/**
 * Access-gated reverse proxy ("gateway").
 *
 * Every request is validated server-side against CONFIG.ACCESS_SEQUENCE before
 * anything is forwarded. Allowed requests are streamed to the target site and
 * the response is streamed back unchanged (except for the URL/cookie rewriting
 * that keeps navigation working, which never touches layout, text or styling).
 * Everything else gets a plain 403.
 */

import { createHash } from 'node:crypto';
import express from 'express';
import { request as undiciRequest } from 'undici';

import { CONFIG } from './config.js';
import { checkAccess } from './access.js';
import { rewriteHtml, rewriteLocation, rewriteSetCookie } from './rewrite.js';

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const HTML_CONTENT_TYPE_RE = /^\s*text\/html\b/i;

/** Minimal, non-reversible audit fingerprint: never the URL itself. */
function urlFingerprint(rawUrl, cfg) {
  return createHash('sha256').update(rawUrl).digest('hex').slice(0, cfg.AUDIT_HASH_LENGTH);
}

function audit(event, fields, cfg) {
  if (!cfg.AUDIT_LOG) return;
  // Deliberately tiny: no path, no query string, no headers, no body.
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/**
 * Remove the access-sequence query parameter from the raw request target while
 * preserving every other character exactly as the browser sent it.
 */
function stripTokenQuery(rawUrl, cfg) {
  const questionMark = rawUrl.indexOf('?');
  if (questionMark === -1) return rawUrl;

  const path = rawUrl.slice(0, questionMark);
  const query = rawUrl.slice(questionMark + 1);
  const kept = query
    .split('&')
    .filter((pair) => {
      if (!pair) return false;
      const rawName = pair.split('=')[0];
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        /* keep raw name */
      }
      return name !== cfg.TOKEN_QUERY_PARAM;
    })
    .join('&');

  return kept ? `${path}?${kept}` : path;
}

/** Build the upstream URL for a request, stripped of the wrapper's own token. */
export function upstreamUrlFor(rawUrl, cfg) {
  const forwarded = cfg.STRIP_TOKEN_BEFORE_FORWARDING ? stripTokenQuery(rawUrl, cfg) : rawUrl;
  const safePath = forwarded.startsWith('/') ? forwarded : `/${forwarded}`;
  return new URL(safePath, `${cfg.TARGET_ORIGIN}/`);
}

/**
 * Whether the browser reached the wrapper over https.
 *
 * Computed defensively: by the time an upstream response arrives the request
 * stream may already be detached, so `req.socket` / `req.secure` are only safe
 * to touch while handling the request head.
 */
export function wrapperIsSecure(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().toLowerCase() === 'https';
  }
  try {
    if (req.socket && req.socket.encrypted) return true;
    return req.protocol === 'https';
  } catch {
    return false;
  }
}

/** Headers to send upstream: the browser's own, re-pointed at the target. */
export function upstreamHeadersFor(req, cfg) {
  const headers = {};

  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
    if (lower === 'accept-encoding') continue;
    if (value === undefined) continue;
    headers[lower] = value;
  }

  const targetHost = new URL(cfg.TARGET_ORIGIN).host;
  headers.host = targetHost;

  if (cfg.REWRITE_LINKS && cfg.REWRITE_NEEDS_IDENTITY_ENCODING) {
    // Uncompressed bodies are required to rewrite markup without a
    // decompress/recompress round trip. Anything else keeps identity too,
    // which is valid and costs bandwidth only.
    headers['accept-encoding'] = 'identity';
  } else if (req.headers['accept-encoding']) {
    headers['accept-encoding'] = req.headers['accept-encoding'];
  }

  // Re-point same-origin metadata headers at the target site.
  const wrapperOrigin = `${wrapperIsSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
  for (const name of ['referer', 'origin']) {
    const current = headers[name];
    if (typeof current === 'string' && current.startsWith('http')) {
      try {
        const parsed = new URL(current);
        if (current.startsWith(wrapperOrigin) || parsed.host === req.headers.host) {
          headers[name] = `${cfg.TARGET_ORIGIN}${parsed.pathname}${parsed.search}`;
        }
      } catch {
        /* leave malformed header alone */
      }
    }
  }

  if (cfg.UPSTREAM_USER_AGENT) headers['user-agent'] = cfg.UPSTREAM_USER_AGENT;

  return headers;
}

/** Response headers to expose to the browser. */
export function downstreamHeadersFor(upstreamHeaders, wrapperSecure, cfg) {
  const headers = {};
  const stripped = new Set(cfg.STRIP_RESPONSE_HEADERS.map((h) => h.toLowerCase()));

  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
    if (stripped.has(lower)) continue;
    if (value === undefined) continue;

    if (lower === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : [value];
      headers['set-cookie'] = cookies.map((cookie) => rewriteSetCookie(cookie, wrapperSecure, cfg));
      continue;
    }

    if (lower === 'location' && cfg.REWRITE_LINKS) {
      headers.location = rewriteLocation(Array.isArray(value) ? value[0] : value, cfg);
      continue;
    }

    headers[lower] = value;
  }

  return headers;
}

/**
 * Create the Express application.
 *
 * @param {object} [cfg] Gateway configuration (defaults to CONFIG).
 * @returns {import('express').Express}
 */
export function createApp(cfg = CONFIG) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', cfg.TRUST_PROXY);

  // Single gate. No static assets, no admin routes: everything is either a
  // valid proxy request or a 403.
  app.use((req, res) => {
    const rawUrl = req.originalUrl || req.url;
    const fingerprint = urlFingerprint(rawUrl, cfg);
    const decision = checkAccess(rawUrl, cfg);

    if (!decision.allowed) {
      audit('blocked', { method: req.method, urlLength: rawUrl.length, urlHash: fingerprint }, cfg);
      res.status(403);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex');
      res.end('Access blocked: required access sequence not found.\n');
      return;
    }

    proxyRequest(req, res, cfg, fingerprint).catch((error) => {
      audit(
        'upstream_error',
        { method: req.method, urlHash: fingerprint, message: String(error && error.message).slice(0, 120) },
        cfg,
      );
      if (!res.headersSent) {
        res.status(502);
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.end('Gateway error: the target site could not be reached.\n');
      } else {
        res.destroy();
      }
    });
  });

  return app;
}

async function proxyRequest(req, res, cfg, fingerprint) {
  const rawUrl = req.originalUrl || req.url;
  const upstreamUrl = upstreamUrlFor(rawUrl, cfg);
  const wrapperSecure = wrapperIsSecure(req);
  const headers = upstreamHeadersFor(req, cfg);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? req : undefined;

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  const upstream = await undiciRequest(upstreamUrl, {
    method: req.method,
    headers,
    body,
    signal: abort.signal,
    headersTimeout: cfg.UPSTREAM_TIMEOUT_MS,
    bodyTimeout: cfg.UPSTREAM_TIMEOUT_MS,
    maxRedirections: 0,
  });

  const responseHeaders = downstreamHeadersFor(upstream.headers, wrapperSecure, cfg);
  const contentType = String(upstream.headers['content-type'] || '');
  const status = upstream.statusCode;

  audit(
    'allowed',
    { method: req.method, urlHash: fingerprint, urlLength: rawUrl.length, status },
    cfg,
  );

  const canRewrite =
    cfg.REWRITE_LINKS && HTML_CONTENT_TYPE_RE.test(contentType) && req.method !== 'HEAD';

  if (!canRewrite) {
    delete responseHeaders['content-length'];
    res.writeHead(status, responseHeaders);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    upstream.body.pipe(res);
    return;
  }

  const chunks = [];
  let size = 0;
  let overflow = false;

  for await (const chunk of upstream.body) {
    if (overflow) {
      // Too large to rewrite safely: keep streaming through untouched.
      res.write(chunk);
      continue;
    }
    chunks.push(chunk);
    size += chunk.length;
    if (size > cfg.MAX_HTML_REWRITE_BYTES) {
      overflow = true;
      delete responseHeaders['content-length'];
      res.writeHead(status, responseHeaders);
      for (const buffered of chunks) res.write(buffered);
      chunks.length = 0;
    }
  }

  if (overflow) {
    res.end();
    return;
  }

  const html = Buffer.concat(chunks).toString('utf8');
  const pagePath = `${upstreamUrl.pathname}${upstreamUrl.search}`;
  const rewritten = Buffer.from(rewriteHtml(html, pagePath, cfg), 'utf8');

  delete responseHeaders['content-encoding'];
  responseHeaders['content-length'] = String(rewritten.length);
  res.writeHead(status, responseHeaders);
  res.end(rewritten);
}
