import test from 'node:test';
import assert from 'node:assert/strict';

import { findAccessSequence, matchesAccessSequence, accessCandidates, checkAccess } from '../src/access.js';
import { CONFIG } from '../src/config.js';

const SEQ = 'annas-arichive';
const SPAN = 17;

const allowed = (url) => matchesAccessSequence(url, SEQ, SPAN, true);
const span = (url) => findAccessSequence(url, SEQ, SPAN, true)?.span ?? null;

test('the configured sequence is 14 characters and contains a dash', () => {
  assert.equal(CONFIG.ACCESS_SEQUENCE.length, 14);
  assert.ok(CONFIG.ACCESS_SEQUENCE.includes('-'));
  assert.equal(CONFIG.ACCESS_SEQUENCE, SEQ);
  assert.equal(CONFIG.MAX_SEQUENCE_SPAN, 17);
});

test('exact sequence is allowed', () => {
  assert.equal(allowed(`${SEQ}`), true);
  assert.equal(span(`${SEQ}`), 14);
});

test('sequence at the end of a normal path is allowed', () => {
  assert.equal(allowed(`/${SEQ}`), true);
  assert.equal(allowed(`/search?q=dune&k=${SEQ}`), true);
  assert.equal(span(`/search?q=dune&k=${SEQ}`), 14);
});

test('up to three spacer characters are allowed (span <= 17)', () => {
  assert.equal(span('annas-arichive'), 14);
  assert.equal(span('annas--arichive'), 15);
  assert.equal(span('annas-an-richive'), 16);
  assert.equal(span('annas-an-r-ichive'), 17);
  assert.equal(allowed('annas-an-r-ichive'), true);
});

test('more spacers than the span allows are blocked', () => {
  assert.equal(allowed('annas---arichive'), true); // span 16
  assert.equal(allowed('annas-an-r--ichive'), false); // span 18
  assert.equal(allowed('annas--a-r--ichive'), false); // span 18
  assert.equal(allowed('annas----a-richive'), false); // span 18
  assert.equal(allowed('a-n-n-a-s----arichive'), false); // span 20
});

test('span limit is measured first character to last, not total URL length', () => {
  const longPrefix = '/some/deep/path/that/is/long?x=1&y=2&k=';
  assert.equal(allowed(`${longPrefix}${SEQ}`), true);
  const longSuffix = `/${SEQ}/and/more/path?with=stuff`;
  assert.equal(allowed(longSuffix), true);
});

test('characters may appear before, between and after the sequence', () => {
  assert.equal(allowed(`/abc${SEQ}xyz`), true);
  assert.equal(allowed(`/an-nas-arichive`), true); // span 15
});

test('wrong spelling (correct English "archive") is blocked', () => {
  assert.equal(allowed('/annas-archive'), false);
  assert.equal(allowed('/search?q=annas-archive&x=1'), false);
});

test('out-of-order characters are blocked', () => {
  assert.equal(allowed('arichive-annas'), false);
  assert.equal(allowed('annas-arichive'.split('').reverse().join('')), false);
});

test('partial sequences are blocked', () => {
  assert.equal(allowed('annas-arichiv'), false);
  assert.equal(allowed('annas'), false);
  assert.equal(allowed(''), false);
  assert.equal(allowed('/'), false);
});

test('matching is case-sensitive by default', () => {
  assert.equal(allowed('ANNAS-ARICHIVE'), false);
  assert.equal(allowed('Annas-Arichive'), false);
});

test('case-insensitive matching is available as an option', () => {
  assert.equal(matchesAccessSequence('ANNAS-ARICHIVE', SEQ, SPAN, false), true);
  assert.equal(matchesAccessSequence('Annas--Arichive', SEQ, SPAN, false), true);
  assert.equal(matchesAccessSequence('ANNAS-ARI--CHIVE', SEQ, SPAN, false), true); // span 16
  // the span rule still applies in case-insensitive mode
  assert.equal(matchesAccessSequence('ANNAS-AN-R--ICHIVE', SEQ, SPAN, false), false); // span 18
});

test('percent-encoded requests are matched after decoding', () => {
  const candidates = accessCandidates('/x?k=annas%2Darichive');
  assert.equal(candidates.length, 2);
  const cfg = { ...CONFIG, TARGET_ORIGIN: 'https://example.test' };
  assert.equal(checkAccess('/x?k=annas%2Darichive', cfg).allowed, true);
  assert.equal(checkAccess('/x?k=annas-arichive', cfg).allowed, true);
  assert.equal(checkAccess('/x?k=nothing', cfg).allowed, false);
});

test('malformed percent-encoding does not throw', () => {
  assert.doesNotThrow(() => accessCandidates('/x?k=%E0%A4%A'));
  assert.equal(accessCandidates('/x?k=%E0%A4%A').length >= 1, true);
});

test('a span limit smaller than the sequence can never match', () => {
  assert.equal(matchesAccessSequence(SEQ, SEQ, 13, true), false);
  assert.equal(matchesAccessSequence(SEQ, SEQ, 14, true), true);
});

test('repeated first characters are handled', () => {
  // "annas" starts with "a"; greedy matching from the first "a" would overshoot,
  // but starting later still fits inside the span.
  assert.equal(allowed('/aaa-nnas-arichive'), true); // span 17 from the first "a"
  assert.equal(matchesAccessSequence('aaaa' + SEQ, SEQ, SPAN, true), true);
  assert.equal(span('aaaa' + SEQ), 17);
});

test('the match reports inclusive positions', () => {
  const match = findAccessSequence('xx-annas-arichive-yy', SEQ, SPAN, true);
  assert.deepEqual(match, { start: 3, end: 16, span: 14 });
});

test('checkAccess uses the configured span and case settings', () => {
  const cfg = { ...CONFIG, TARGET_ORIGIN: 'https://example.test' };
  assert.deepEqual(checkAccess(`/${SEQ}`, cfg).allowed, true);
  assert.equal(checkAccess('/nope', cfg).allowed, false);
  const insensitive = { ...cfg, CASE_SENSITIVE: false };
  assert.equal(checkAccess('/ANNAS-ARICHIVE', insensitive).allowed, true);
});
