import test from 'node:test';
import assert from 'node:assert/strict';

import { isTargetAllowed, assertTargetAllowed } from '../src/target-policy.js';
import { createApp } from '../src/server.js';
import { CONFIG } from '../src/config.js';

const cfg = (overrides = {}) => ({ ...CONFIG, ...overrides });

test('the shipped configuration is locked to Anna\'s Archive', () => {
  assert.equal(CONFIG.ENFORCE_TARGET_ALLOWLIST, true);
  assert.deepEqual(CONFIG.ALLOWED_TARGET_HOST_MARKERS, ['annas-archive']);
  assert.equal(CONFIG.TARGET_ORIGIN, 'https://annas-archive.gl');
  assert.equal(isTargetAllowed(CONFIG.TARGET_ORIGIN, CONFIG), true);
  assert.doesNotThrow(() => assertTargetAllowed(CONFIG));
});

test('every annas-archive host is accepted', () => {
  const allowed = [
    'https://annas-archive.gl',
    'https://www.annas-archive.gl',
    'https://annas-archive.org',
    'https://annas-archive.se',
    'https://annas-archive.li',
    'http://annas-archive.gl:8080',
    'https://annas-archive-gateway.onrender.com',
    'https://AnNaS-ArChIvE.gl',
  ];
  for (const origin of allowed) {
    assert.equal(isTargetAllowed(origin, cfg()), true, origin);
  }
});

test('unrelated sites are refused, even when the path mentions annas-archive', () => {
  const refused = [
    'https://example.com',
    'https://google.com',
    'https://annasarchive.gl',
    'https://annas-archiv.gl',
    'https://evil.example/annas-archive.gl',
    'file:///etc/passwd',
    'ftp://annas-archive.gl',
    'javascript:alert(1)',
    'not a url',
    '',
    'https://user:pass@annas-archive.gl',
  ];
  for (const origin of refused) {
    assert.equal(isTargetAllowed(origin, cfg()), false, origin);
  }
});

test('the lock can be lifted explicitly (tests and deliberately different builds)', () => {
  assert.equal(isTargetAllowed('https://example.com', cfg({ ENFORCE_TARGET_ALLOWLIST: false })), true);
});

test('markers are configurable', () => {
  const custom = cfg({ ALLOWED_TARGET_HOST_MARKERS: ['annas-archive', 'annasarchive'] });
  assert.equal(isTargetAllowed('https://annasarchive.gl', custom), true);
});

test('createApp refuses to build an app for a disallowed target', () => {
  assert.throws(
    () => createApp(cfg({ TARGET_ORIGIN: 'https://example.com' })),
    /Target lock/,
  );
  assert.doesNotThrow(() => createApp(cfg({ TARGET_ORIGIN: 'https://annas-archive.gl' })));
});
