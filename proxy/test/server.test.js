import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { createApp } from '../src/server.js';
import { CONFIG } from '../src/config.js';

const SEQ = CONFIG.ACCESS_SEQUENCE;
const TOKEN = `${CONFIG.TOKEN_QUERY_PARAM}=${SEQ}`;

/** Minimal fake target site. Records what the gateway sent upstream. */
async function startOrigin() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });

      if (req.url.startsWith('/redirect')) {
        res.writeHead(302, { Location: '/landing?ok=1' });
        res.end();
        return;
      }
      if (req.url.startsWith('/external-redirect')) {
        res.writeHead(302, { Location: 'https://elsewhere.test/x' });
        res.end();
        return;
      }
      if (req.url.startsWith('/cookie')) {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Set-Cookie': [
            'sid=abc123; Domain=annas-archive.gl; Path=/; Secure; HttpOnly',
            'pref=dark; Domain=.annas-archive.gl; Path=/; SameSite=None; Secure',
          ],
        });
        res.end('ok');
        return;
      }
      if (req.url.startsWith('/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
        return;
      }
      if (req.url.startsWith('/html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const absoluteTarget = `http://${req.headers.host}/book/def`;
        res.end(`<!doctype html><html><head><title>t</title></head><body>
          <a href="/book/abc">root relative</a>
          <a href="${absoluteTarget}">absolute target</a>
          <a href="https://cdn.example.net/x.js">external</a>
          <a href="#top">fragment</a>
          <a href="mailto:a@b.c">mail</a>
          <img src="/img/cover.jpg?size=2">
          <form action="/search" method="get"><input name="q"></form>
          <p>Visible text stays identical.</p>
        </body></html>`);
        return;
      }
      if (req.url.startsWith('/compressed')) {
        const gzipped = zlib.gzipSync('<a href="/book/abc">x</a>');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': String(gzipped.length),
        });
        res.end(gzipped);
        return;
      }
      if (req.url.startsWith('/big')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<a href="/x">x</a>'.repeat(4));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`origin saw ${req.method} ${req.url}`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, seen, origin: `http://127.0.0.1:${port}` };
}

async function startGateway(overrides = {}) {
  const origin = await startOrigin();
  const cfg = {
    ...CONFIG,
    TARGET_ORIGIN: origin.origin,
    AUDIT_LOG: false,
    ...overrides,
  };
  const app = createApp(cfg);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    cfg,
    seen: origin.seen,
    async close() {
      server.closeAllConnections?.();
      origin.server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await new Promise((r) => origin.server.close(r));
    },
  };
}

test('requests without the access sequence get a 403 and never reach the target', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/book/abc`);
    const body = await res.text();
    assert.equal(res.status, 403);
    assert.match(body, /Access blocked: required access sequence not found\./);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(gw.seen.length, 0);
  } finally {
    await gw.close();
  }
});

test('a request carrying the sequence is proxied and the token is stripped upstream', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/book/abc?${TOKEN}`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(body, 'origin saw GET /book/abc');
    assert.equal(gw.seen[0].url, '/book/abc');
  } finally {
    await gw.close();
  }
});

test('the sequence may appear anywhere inside the span limit', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/an-nas-arichive`);
    assert.equal(res.status, 200);
    assert.equal(gw.seen[0].url, '/an-nas-arichive');
  } finally {
    await gw.close();
  }
});

test('a too-wide match is blocked', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/annas-an-r--ichive`); // span 18
    assert.equal(res.status, 403);
    assert.equal(gw.seen.length, 0);
  } finally {
    await gw.close();
  }
});

test('HTML keeps its text but links gain the access sequence', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/html?${TOKEN}`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(body, /Visible text stays identical\./);
    assert.match(body, new RegExp(`href="/book/abc\\?${TOKEN}"`));
    assert.match(body, new RegExp(`href="/book/def\\?${TOKEN}"`));
    assert.match(body, /href="https:\/\/cdn\.example\.net\/x\.js"/);
    assert.match(body, /href="#top"/);
    assert.match(body, /href="mailto:a@b\.c"/);
    // A bare "&" is valid HTML5 here (not an ambiguous ampersand); existing
    // "&amp;" separators are preserved when present.
    assert.match(body, new RegExp(`src="/img/cover\\.jpg\\?size=2&(?:amp;)?${TOKEN}"`));
    assert.match(body, new RegExp(`action="/search\\?${TOKEN}"`));
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(body)));
  } finally {
    await gw.close();
  }
});

test('uncompressed HTML is requested upstream when rewriting is enabled', async () => {
  const gw = await startGateway();
  try {
    await fetch(`${gw.base}/html?${TOKEN}`);
    assert.equal(gw.seen[0].headers['accept-encoding'], 'identity');
    assert.equal(gw.seen[0].headers.host, new URL(gw.cfg.TARGET_ORIGIN).host);
  } finally {
    await gw.close();
  }
});

test('compressed HTML is passed through instead of being rewritten', async () => {
  const gw = await startGateway();
  try {
    const { status, headers, body } = await new Promise((resolve, reject) => {
      const request = http.get(`${gw.base}/compressed?${TOKEN}`, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      request.on('error', reject);
    });

    assert.equal(status, 200);
    assert.equal(headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(body).toString(), /href="\/book\/abc"/);
  } finally {
    await gw.close();
  }
});

test('non-HTML bodies pass through untouched', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/json?${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), JSON.stringify({ hello: 'world' }));
    assert.equal(res.headers.get('content-type'), 'application/json');
  } finally {
    await gw.close();
  }
});

test('cookies are re-scoped to the wrapper host', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/cookie?${TOKEN}`);
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0], 'sid=abc123; Path=/; HttpOnly');
    assert.equal(cookies[1], 'pref=dark; Path=/; SameSite=Lax');
  } finally {
    await gw.close();
  }
});

test('redirects stay on the wrapper and carry the sequence', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/redirect?${TOKEN}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/landing?ok=1&${TOKEN}`);
  } finally {
    await gw.close();
  }
});

test('third-party redirects are left alone', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/external-redirect?${TOKEN}`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), 'https://elsewhere.test/x');
  } finally {
    await gw.close();
  }
});

test('request bodies and methods are forwarded', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/submit?${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'q=dune',
    });
    assert.equal(res.status, 200);
    assert.equal(gw.seen[0].method, 'POST');
    assert.equal(gw.seen[0].body, 'q=dune');
  } finally {
    await gw.close();
  }
});

test('absolute-form request targets cannot redirect the proxy elsewhere', async () => {
  const gw = await startGateway();
  try {
    // A raw HTTP client can send "GET http://evil.test/x HTTP/1.1".
    const status = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: new URL(gw.base).port,
          method: 'GET',
          path: `http://evil.test/steal?${TOKEN}`,
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.end();
    });

    assert.equal(status, 200);
    assert.equal(gw.seen.length, 1);
    assert.equal(gw.seen[0].url, '/steal');
    assert.equal(gw.seen[0].headers.host, new URL(gw.cfg.TARGET_ORIGIN).host);
  } finally {
    await gw.close();
  }
});

test('upstream failures surface as 502', async () => {
  const gw = await startGateway({ TARGET_ORIGIN: 'http://127.0.0.1:1' });
  try {
    const res = await fetch(`${gw.base}/?${TOKEN}`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Gateway error/);
  } finally {
    await gw.close();
  }
});

test('strict mode (no rewriting) returns the target body byte-for-byte', async () => {
  const gw = await startGateway({ REWRITE_LINKS: false });
  try {
    const res = await fetch(`${gw.base}/html?${TOKEN}`);
    const body = await res.text();
    assert.match(body, /<a href="\/book\/abc">root relative<\/a>/);
    assert.doesNotMatch(body, new RegExp(TOKEN));
    assert.match(String(gw.seen[0].headers['accept-encoding']), /gzip/);
  } finally {
    await gw.close();
  }
});

test('oversized HTML is streamed through instead of buffered', async () => {
  const gw = await startGateway({ MAX_HTML_REWRITE_BYTES: 10 });
  try {
    const res = await fetch(`${gw.base}/big?${TOKEN}`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(body, '<a href="/x">x</a>'.repeat(4));
  } finally {
    await gw.close();
  }
});

test('case-insensitive mode accepts upper-case sequences', async () => {
  const gw = await startGateway({ CASE_SENSITIVE: false });
  try {
    const res = await fetch(`${gw.base}/book/abc?gateway=ANNAS-ARICHIVE`);
    assert.equal(res.status, 200);
  } finally {
    await gw.close();
  }
});

test('HEAD requests work', async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(`${gw.base}/json?${TOKEN}`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  } finally {
    await gw.close();
  }
});
