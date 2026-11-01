/**
 * Target lock.
 *
 * The wrapper is pinned to Anna's Archive: the configured TARGET_ORIGIN must be
 * an http(s) URL whose host contains one of the configured markers
 * ("annas-archive" by default). That allows annas-archive.gl,
 * www.annas-archive.gl, annas-archive.org, annas-archive.se, ... and refuses
 * anything else, so a deployed gateway cannot be re-pointed at an unrelated
 * site by changing an environment variable.
 */

/**
 * @param {string} origin  Candidate target origin, e.g. "https://annas-archive.gl".
 * @param {object} cfg     Gateway configuration.
 * @returns {boolean} true when the origin is allowed (or the lock is disabled).
 */
export function isTargetAllowed(origin, cfg) {
  if (!cfg.ENFORCE_TARGET_ALLOWLIST) return true;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!url.hostname) return false;
  // Credentials in the target URL are never legitimate here.
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase();
  const markers = cfg.ALLOWED_TARGET_HOST_MARKERS || [];
  if (markers.length === 0) return false;

  return markers.some((marker) => hostname.includes(String(marker).toLowerCase()));
}

/**
 * Fail-closed guard used at startup.
 *
 * @param {object} cfg Gateway configuration.
 * @throws {Error} when the configured target is not an allowed Anna's Archive host.
 */
export function assertTargetAllowed(cfg) {
  if (isTargetAllowed(cfg.TARGET_ORIGIN, cfg)) return;

  const markers = (cfg.ALLOWED_TARGET_HOST_MARKERS || []).join(', ') || '(none configured)';
  throw new Error(
    `Target lock: TARGET_ORIGIN "${cfg.TARGET_ORIGIN}" is not an allowed Anna's Archive host. ` +
      `The host must contain one of: ${markers}. ` +
      'Change TARGET_ORIGIN or ALLOWED_TARGET_HOST_MARKERS in src/config.js ' +
      '(or set ENFORCE_TARGET_ALLOWLIST=false if you really mean to proxy a different site).',
  );
}
