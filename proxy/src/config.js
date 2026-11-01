/**
 * ============================================================================
 *  GATEWAY CONFIGURATION  --  edit this block, nothing else is required
 * ============================================================================
 *
 *  TARGET_ORIGIN
 *      The site the wrapper forwards to. Scheme + host (+ optional port).
 *      No trailing slash is required; a trailing slash is stripped.
 *
 *  ACCESS_SEQUENCE
 *      The required ordered character sequence. A request is allowed only when
 *      every character of this string appears, in this order, inside the
 *      requested URL (path + query string), and the span from the first matched
 *      character to the last matched character is no longer than
 *      MAX_SEQUENCE_SPAN characters (counting every character in between).
 *
 *  MAX_SEQUENCE_SPAN
 *      Maximum span, in characters, from the first character of the sequence to
 *      the last character of the sequence. Spacer characters count toward it.
 *      With a 14-character sequence and a span of 17 you may insert up to
 *      3 extra characters anywhere between the first and last character.
 *
 *  CASE_SENSITIVE
 *      true  -> "annas-arichive" matches, "ANNAS-ARICHIVE" does not.
 *      false -> matching is case-insensitive.
 *
 *  Every field can also be overridden with an environment variable of the same
 *  name (see .env.example), so the same build can be deployed to several hosts
 *  without editing the file.
 * ============================================================================
 */

const env = process.env;

/** Read an env override, keeping the literal default when it is absent/blank. */
function envString(name, fallback) {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

const DEFAULTS = {
  // ---- the three values you asked to be able to change easily ------------
  TARGET_ORIGIN: 'https://annas-archive.gl',
  ACCESS_SEQUENCE: 'annas-arichive',
  MAX_SEQUENCE_SPAN: 17,
  CASE_SENSITIVE: true,
  // -----------------------------------------------------------------------

  // Query parameter the wrapper uses when it needs to carry the access
  // sequence across links / redirects / form posts (e.g. ?gateway=annas-arichive).
  TOKEN_QUERY_PARAM: 'gateway',

  // Remove the token query parameter before forwarding upstream, so the target
  // site receives the exact URL it would have received without the wrapper.
  // Set to false if you would rather forward the parameter untouched.
  STRIP_TOKEN_BEFORE_FORWARDING: true,

  // Append the access sequence to links, assets, forms and redirects so normal
  // browsing keeps working after the first page load. Best-effort HTML
  // rewriting; it never changes layout, styling or visible text.
  // Set to false for a byte-for-byte passthrough (see README: "Strict mode").
  REWRITE_LINKS: true,

  // When REWRITE_LINKS is on, ask upstream for uncompressed HTML so it can be
  // rewritten without decompressing/recompressing. Non-HTML keeps its encoding.
  REWRITE_NEEDS_IDENTITY_ENCODING: true,

  // Refuse to buffer (and therefore refuse to rewrite) HTML bodies larger than
  // this many bytes; such responses are streamed through unchanged.
  MAX_HTML_REWRITE_BYTES: 8 * 1024 * 1024,

  // Cookie handling. The wrapper terminates TLS for the browser, so cookies
  // coming back from the target must be re-scoped to the wrapper's host.
  STRIP_COOKIE_DOMAIN: true,
  // Drop the Secure flag when the wrapper itself is served over plain http
  // (otherwise the browser would silently discard the cookie).
  DROP_SECURE_COOKIE_ON_HTTP: true,
  // Rewrite SameSite=None to SameSite=Lax when Secure had to be dropped,
  // because browsers reject SameSite=None without Secure.
  FIX_SAMESITE_ON_HTTP: true,

  // Response headers that would break a proxied origin (CSP pins resource
  // origins to the target site, HSTS pins https, X-Frame-Options blocks
  // embedding). Removing them does not change how the site looks or behaves.
  STRIP_RESPONSE_HEADERS: [
    'content-security-policy',
    'content-security-policy-report-only',
    'strict-transport-security',
    'x-frame-options',
    'alt-svc',
    'content-location',
  ],

  // ---- audit logging (deliberately minimal) ------------------------------
  // Never log full URLs, paths, query strings, headers or bodies. Blocked
  // requests are reduced to: timestamp, method, URL length and a truncated
  // SHA-256 of the URL (enough to correlate repeat offenders, useless for
  // reconstructing the path).
  AUDIT_LOG: true,
  AUDIT_HASH_LENGTH: 12,

  // ---- networking --------------------------------------------------------
  PORT: 8080,
  HOST: '0.0.0.0',
  UPSTREAM_TIMEOUT_MS: 60_000,
  // Optional: pin the User-Agent the wrapper sends upstream. Empty string means
  // "forward the browser's own User-Agent".
  UPSTREAM_USER_AGENT: '',
  TRUST_PROXY: true,
};

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = Object.freeze({
  TARGET_ORIGIN: envString('TARGET_ORIGIN', DEFAULTS.TARGET_ORIGIN).replace(/\/+$/, ''),
  ACCESS_SEQUENCE: envString('ACCESS_SEQUENCE', DEFAULTS.ACCESS_SEQUENCE),
  MAX_SEQUENCE_SPAN: parseNumber(
    envString('MAX_SEQUENCE_SPAN', DEFAULTS.MAX_SEQUENCE_SPAN),
    DEFAULTS.MAX_SEQUENCE_SPAN,
  ),
  CASE_SENSITIVE: parseBoolean(envString('CASE_SENSITIVE', DEFAULTS.CASE_SENSITIVE), DEFAULTS.CASE_SENSITIVE),
  TOKEN_QUERY_PARAM: envString('TOKEN_QUERY_PARAM', DEFAULTS.TOKEN_QUERY_PARAM),
  STRIP_TOKEN_BEFORE_FORWARDING: parseBoolean(
    envString('STRIP_TOKEN_BEFORE_FORWARDING', DEFAULTS.STRIP_TOKEN_BEFORE_FORWARDING),
    DEFAULTS.STRIP_TOKEN_BEFORE_FORWARDING,
  ),
  REWRITE_LINKS: parseBoolean(envString('REWRITE_LINKS', DEFAULTS.REWRITE_LINKS), DEFAULTS.REWRITE_LINKS),
  REWRITE_NEEDS_IDENTITY_ENCODING: parseBoolean(
    envString('REWRITE_NEEDS_IDENTITY_ENCODING', DEFAULTS.REWRITE_NEEDS_IDENTITY_ENCODING),
    DEFAULTS.REWRITE_NEEDS_IDENTITY_ENCODING,
  ),
  MAX_HTML_REWRITE_BYTES: parseNumber(
    envString('MAX_HTML_REWRITE_BYTES', DEFAULTS.MAX_HTML_REWRITE_BYTES),
    DEFAULTS.MAX_HTML_REWRITE_BYTES,
  ),
  STRIP_COOKIE_DOMAIN: parseBoolean(
    envString('STRIP_COOKIE_DOMAIN', DEFAULTS.STRIP_COOKIE_DOMAIN),
    DEFAULTS.STRIP_COOKIE_DOMAIN,
  ),
  DROP_SECURE_COOKIE_ON_HTTP: parseBoolean(
    envString('DROP_SECURE_COOKIE_ON_HTTP', DEFAULTS.DROP_SECURE_COOKIE_ON_HTTP),
    DEFAULTS.DROP_SECURE_COOKIE_ON_HTTP,
  ),
  FIX_SAMESITE_ON_HTTP: parseBoolean(
    envString('FIX_SAMESITE_ON_HTTP', DEFAULTS.FIX_SAMESITE_ON_HTTP),
    DEFAULTS.FIX_SAMESITE_ON_HTTP,
  ),
  STRIP_RESPONSE_HEADERS: DEFAULTS.STRIP_RESPONSE_HEADERS,
  AUDIT_LOG: parseBoolean(envString('AUDIT_LOG', DEFAULTS.AUDIT_LOG), DEFAULTS.AUDIT_LOG),
  AUDIT_HASH_LENGTH: parseNumber(
    envString('AUDIT_HASH_LENGTH', DEFAULTS.AUDIT_HASH_LENGTH),
    DEFAULTS.AUDIT_HASH_LENGTH,
  ),
  PORT: parseNumber(envString('PORT', DEFAULTS.PORT), DEFAULTS.PORT),
  HOST: envString('HOST', DEFAULTS.HOST),
  UPSTREAM_TIMEOUT_MS: parseNumber(
    envString('UPSTREAM_TIMEOUT_MS', DEFAULTS.UPSTREAM_TIMEOUT_MS),
    DEFAULTS.UPSTREAM_TIMEOUT_MS,
  ),
  UPSTREAM_USER_AGENT: envString('UPSTREAM_USER_AGENT', DEFAULTS.UPSTREAM_USER_AGENT),
  TRUST_PROXY: parseBoolean(envString('TRUST_PROXY', DEFAULTS.TRUST_PROXY), DEFAULTS.TRUST_PROXY),
});
