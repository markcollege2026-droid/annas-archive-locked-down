import test from 'node:test';
import assert from 'node:assert/strict';

import { appendToken, rewriteUrlValue, rewriteHtml, rewriteLocation, rewriteSetCookie } from '../src/rewrite.js';
import { CONFIG } from '../src/config.js';

const cfg = { ...CONFIG, TARGET_ORIGIN: 'https://annas-archive.gl' };
const TOKEN = `${cfg.TOKEN_QUERY_PARAM}=${cfg.ACCESS_SEQUENCE}`;

test('appendToken adds the first query parameter', () => {
  assert.equal(appendToken('/search', cfg), `/search?${TOKEN}`);
});

test('appendToken extends an existing query string', () => {
  assert.equal(appendToken('/search?q=dune', cfg), `/search?q=dune&${TOKEN}`);
  assert.equal(appendToken('/search?q=dune', cfg, '&amp;'), `/search?q=dune&amp;${TOKEN}`);
});

test('appendToken keeps fragments last', () => {
  assert.equal(appendToken('/book/1#reviews', cfg), `/book/1?${TOKEN}#reviews`);
  assert.equal(appendToken('/book/1?x=1#reviews', cfg), `/book/1?x=1&${TOKEN}#reviews`);
});

test('appendToken is idempotent', () => {
  const once = appendToken('/search?q=dune', cfg);
  assert.equal(appendToken(once, cfg), once);
});

test('relative and root-relative URLs are rewritten', () => {
  assert.equal(rewriteUrlValue('/book/abc', '/', cfg), `/book/abc?${TOKEN}`);
  assert.equal(rewriteUrlValue('book/abc', '/list/page', cfg), `/list/book/abc?${TOKEN}`);
});

test('absolute URLs pointing at the target are made wrapper-relative', () => {
  assert.equal(
    rewriteUrlValue('https://annas-archive.gl/book/def?x=1', '/', cfg),
    `/book/def?x=1&${TOKEN}`,
  );
});

test('third-party, special and already-tokenised URLs are left alone', () => {
  assert.equal(rewriteUrlValue('https://cdn.example.net/x.js', '/', cfg), null);
  assert.equal(rewriteUrlValue('mailto:a@b.c', '/', cfg), null);
  assert.equal(rewriteUrlValue('#top', '/', cfg), null);
  assert.equal(rewriteUrlValue('javascript:void(0)', '/', cfg), null);
  assert.equal(rewriteUrlValue('/x?gateway=annas-arichive', '/', cfg), null);
  assert.equal(rewriteUrlValue('   ', '/', cfg), null);
});

test('rewriteHtml only touches URL attributes', () => {
  const html = '<a href="/a" class="annas-arichive">text</a><img src=/img/x.png>';
  const out = rewriteHtml(html, '/', cfg);
  assert.match(out, new RegExp(`href="/a\\?${TOKEN}"`));
  assert.match(out, /class="annas-arichive"/);
  // unquoted attributes are out of scope (best effort)
  assert.match(out, /<img src=\/img\/x\.png>/);
});

test('rewriteHtml preserves both quote styles and escapes', () => {
  const html = `<a href='/a?x=1&amp;y=2'>x</a><a href="/b">y</a>`;
  const out = rewriteHtml(html, '/', cfg);
  assert.match(out, new RegExp(`href='/a\\?x=1&amp;y=2&amp;${TOKEN}'`));
  assert.match(out, new RegExp(`href="/b\\?${TOKEN}"`));
});

test('rewriteLocation converts target redirects and keeps foreign ones', () => {
  assert.equal(rewriteLocation('https://annas-archive.gl/book/1', cfg), `/book/1?${TOKEN}`);
  assert.equal(rewriteLocation('/book/1?x=1', cfg), `/book/1?x=1&${TOKEN}`);
  assert.equal(rewriteLocation('https://elsewhere.test/x', cfg), 'https://elsewhere.test/x');
});

test('rewriteSetCookie strips Domain and downgrades Secure on http', () => {
  assert.equal(
    rewriteSetCookie('sid=1; Domain=.annas-archive.gl; Path=/; Secure; HttpOnly', false, cfg),
    'sid=1; Path=/; HttpOnly',
  );
  assert.equal(
    rewriteSetCookie('sid=1; Domain=.annas-archive.gl; Path=/; Secure', true, cfg),
    'sid=1; Path=/; Secure',
  );
});

test('rewriteSetCookie fixes SameSite=None when Secure is dropped', () => {
  assert.equal(
    rewriteSetCookie('a=1; SameSite=None; Secure; Path=/', false, cfg),
    'a=1; SameSite=Lax; Path=/',
  );
  assert.equal(
    rewriteSetCookie('a=1; SameSite=None; Secure; Path=/', true, cfg),
    'a=1; SameSite=None; Secure; Path=/',
  );
});
