/**
 * Link / cookie / redirect rewriting.
 *
 * The wrapper only ever changes *URLs*, never markup structure, styling or
 * visible text: it appends the access-sequence query parameter to links, asset
 * references, form actions and redirects so that normal browsing keeps working
 * after the first page load. With CONFIG.REWRITE_LINKS = false the proxy passes
 * bodies through byte-for-byte and none of this runs.
 */

const HTML_ATTR_RE = /(\s(?:href|src|action|formaction|poster|data-src|data-href)\s*=\s*)("([^"]*)"|'([^']*)')/gi;
const NON_HTTP_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:)/i;

/**
 * Append the access sequence to a URL string as a query parameter.
 * Works on any URL shape (absolute, root-relative, path-relative) and keeps the
 * original characters intact.
 *
 * @param {string} value          URL to modify.
 * @param {object} cfg            Gateway config.
 * @param {string} [separator]    Query separator to use ("&" or "&amp;").
 * @returns {string} URL carrying the access sequence.
 */
export function appendToken(value, cfg, separator = '&') {
  const tokenParam = `${cfg.TOKEN_QUERY_PARAM}=${encodeURIComponent(cfg.ACCESS_SEQUENCE)}`;
  if (value.includes(tokenParam)) return value;

  const hashIndex = value.indexOf('#');
  const fragment = hashIndex === -1 ? '' : value.slice(hashIndex);
  const withoutFragment = hashIndex === -1 ? value : value.slice(0, hashIndex);

  const joiner = withoutFragment.includes('?')
    ? (withoutFragment.endsWith('?') || withoutFragment.endsWith('&') ? '' : separator)
    : '?';

  return `${withoutFragment}${joiner}${tokenParam}${fragment}`;
}

/**
 * Rewrite a single URL found in markup so it keeps pointing at the right
 * upstream resource *and* carries the access sequence.
 *
 * @param {string} rawValue     Attribute value exactly as it appears in markup.
 * @param {string} pagePath     Upstream path (+query) of the page being rewritten.
 * @param {object} cfg          Gateway config.
 * @param {string} separator    "&" or "&amp;", matching the surrounding markup.
 * @returns {string|null} New value, or null to leave the value untouched.
 */
export function rewriteUrlValue(rawValue, pagePath, cfg, separator = '&') {
  const value = rawValue.trim();
  if (!value) return null;
  if (value.startsWith('#')) return null;

  const lower = value.toLowerCase();
  if (
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('about:') ||
    lower.startsWith('sms:') ||
    lower.startsWith('intent:')
  ) {
    return null;
  }

  // Already carries the access sequence: leave it alone.
  if (value.includes(`${cfg.TOKEN_QUERY_PARAM}=`)) return null;

  let target;
  try {
    // Protocol-relative URLs ("//host/x") are resolved against the wrapper's
    // own scheme by the browser; treat them as target-relative when the host
    // matches, otherwise leave them alone.
    target = new URL(value, `${cfg.TARGET_ORIGIN}${pagePath.startsWith('/') ? '' : '/'}${pagePath}`);
  } catch {
    return null;
  }

  const isAbsolute = NON_HTTP_SCHEME_RE.test(value) || value.startsWith('//');
  if (isAbsolute && !/^https?:/i.test(target.protocol)) return null;

  // Leave third-party origins untouched: the wrapper proxies one site only.
  if (isAbsolute && target.origin !== cfg.TARGET_ORIGIN) return null;
  if (!isAbsolute && target.origin !== cfg.TARGET_ORIGIN) return null;

  const pathAndQuery = `${target.pathname}${target.search}`;
  return appendToken(pathAndQuery, cfg, separator);
}

/**
 * Rewrite the URLs of a page's markup (best effort, attribute-level only).
 *
 * @param {string} body     HTML document.
 * @param {string} pagePath Upstream path of the page (e.g. "/search?q=dune").
 * @param {object} cfg      Gateway config.
 * @returns {string} HTML with access-sequence-carrying URLs.
 */
export function rewriteHtml(body, pagePath, cfg) {
  return body.replace(HTML_ATTR_RE, (match, prefix, quoted, doubleValue, singleValue) => {
    const value = doubleValue !== undefined ? doubleValue : singleValue;
    const quoteChar = quoted[0];
    const separator = value.includes('&amp;') ? '&amp;' : '&';
    const rewritten = rewriteUrlValue(value, pagePath, cfg, separator);
    if (rewritten === null) return match;
    return `${prefix}${quoteChar}${rewritten}${quoteChar}`;
  });
}

/**
 * Rewrite a redirect target so the browser stays on the wrapper and the
 * follow-up request carries the access sequence.
 *
 * @param {string} location  Raw Location header value.
 * @param {object} cfg       Gateway config.
 * @returns {string} Rewritten location (relative URL, same origin as wrapper).
 */
export function rewriteLocation(location, cfg) {
  try {
    const target = new URL(location, cfg.TARGET_ORIGIN);
    if (target.origin !== cfg.TARGET_ORIGIN) return location; // third-party redirect: pass through
    return appendToken(`${target.pathname}${target.search}`, cfg);
  } catch {
    return location;
  }
}

/**
 * Re-scope a Set-Cookie header to the wrapper's own host.
 *
 * The browser talks to the wrapper, so cookies issued for the target's domain
 * must lose their Domain attribute (otherwise the browser discards them).
 * Secure is dropped on plain-http deployments, and SameSite=None is downgraded
 * to Lax in that case because browsers reject SameSite=None without Secure.
 *
 * @param {string} cookie        Raw Set-Cookie header value.
 * @param {boolean} wrapperSecure True when the wrapper itself is served over https.
 * @param {object} cfg           Gateway config.
 * @returns {string} Rewritten cookie header value.
 */
export function rewriteSetCookie(cookie, wrapperSecure, cfg) {
  const parts = cookie.split(';');
  const kept = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const eq = trimmed.indexOf('=');
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase();
    const rawValue = eq === -1 ? '' : trimmed.slice(eq + 1);

    if (name === 'domain' && cfg.STRIP_COOKIE_DOMAIN) continue;

    if (name === 'secure' && !wrapperSecure && cfg.DROP_SECURE_COOKIE_ON_HTTP) continue;

    if (name === 'samesite' && !wrapperSecure && cfg.FIX_SAMESITE_ON_HTTP) {
      if (rawValue.trim().toLowerCase() === 'none') {
        kept.push('SameSite=Lax');
        continue;
      }
    }

    kept.push(eq === -1 ? trimmed : `${trimmed.slice(0, eq)}=${rawValue}`);
  }

  return kept.join('; ');
}
