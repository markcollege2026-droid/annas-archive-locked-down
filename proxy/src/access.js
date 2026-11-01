/**
 * Access-sequence matching.
 *
 * Rule: the required sequence must appear inside the requested URL as an
 * ordered subsequence (characters in the same order, anything may sit between
 * them), and the distance from the first matched character to the last matched
 * character may not exceed `maxSpan` characters — counting every character in
 * between, spacers included.
 *
 * Example with the sequence "annas-arichive" (14 chars) and a span of 17:
 *   /search?x=annas-arichive      -> span 14  -> allowed
 *   /search?x=annas--arichive     -> span 15  -> allowed
 *   /search?x=an-nas--arichive    -> span 17  -> allowed
 *   /search?x=an--nas--arichive   -> span 18  -> blocked
 *   /search?x=annas-archive       -> blocked (wrong spelling, no match)
 */

/**
 * @param {string} haystack  Full requested URL / path + query string.
 * @param {string} sequence  Required ordered character sequence.
 * @param {number} maxSpan   Maximum allowed first-to-last character distance.
 * @param {boolean} [caseSensitive=true]
 * @returns {boolean} true when the sequence matches within the span limit.
 */
export function matchesAccessSequence(haystack, sequence, maxSpan, caseSensitive = true) {
  return findAccessSequence(haystack, sequence, maxSpan, caseSensitive) !== null;
}

/**
 * Same as {@link matchesAccessSequence}, but returns the winning match so it can
 * be inspected during tests or debugging: { start, end, span }. `end` is
 * inclusive. Returns null when no match satisfies the span limit.
 */
export function findAccessSequence(haystack, sequence, maxSpan, caseSensitive = true) {
  if (typeof haystack !== 'string' || typeof sequence !== 'string') return null;
  if (sequence.length === 0) return null;
  if (!Number.isFinite(maxSpan) || maxSpan < sequence.length) return null;

  const hay = caseSensitive ? haystack : haystack.toLowerCase();
  const needle = caseSensitive ? sequence : sequence.toLowerCase();

  // The sequence must fit inside the span limit even with zero spacers.
  if (needle.length > maxSpan) return null;

  // Try every occurrence of the first character as a starting point. For a
  // fixed start, greedily taking the earliest possible position for each
  // following character yields the shortest possible match, so no other
  // arrangement from this start can beat it.
  let start = hay.indexOf(needle[0]);
  while (start !== -1) {
    let cursor = start;
    let matched = true;

    for (let i = 1; i < needle.length; i += 1) {
      const next = hay.indexOf(needle[i], cursor + 1);
      if (next === -1) {
        matched = false;
        break;
      }
      cursor = next;
    }

    if (matched) {
      const span = cursor - start + 1;
      if (span <= maxSpan) return { start, end: cursor, span };
    }

    start = hay.indexOf(needle[0], start + 1);
  }

  return null;
}

/**
 * Candidate strings to test for a request. The raw path+query and its
 * percent-decoded form are both checked, so `/x?q=annas-arichive` and
 * `/x?q=annas%2Darichive` behave the same.
 *
 * @param {string} rawUrl  Raw request target (path + query, as received).
 * @returns {string[]} unique candidates, raw first.
 */
export function accessCandidates(rawUrl) {
  const candidates = [rawUrl];
  try {
    const decoded = decodeURIComponent(rawUrl);
    if (decoded !== rawUrl) candidates.push(decoded);
  } catch {
    // Malformed percent-encoding: the raw string is still checked.
  }
  return candidates;
}

/**
 * Full access decision for a raw request target.
 *
 * @param {string} rawUrl          Raw path + query string of the request.
 * @param {object} cfg             Gateway configuration (see config.js).
 * @returns {{allowed: boolean, match: null | {start: number, end: number, span: number}}}
 */
export function checkAccess(rawUrl, cfg) {
  for (const candidate of accessCandidates(rawUrl)) {
    const match = findAccessSequence(
      candidate,
      cfg.ACCESS_SEQUENCE,
      cfg.MAX_SEQUENCE_SPAN,
      cfg.CASE_SENSITIVE,
    );
    if (match) return { allowed: true, match };
  }
  return { allowed: false, match: null };
}
