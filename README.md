# annas-archive-locked-down

A small, server-side **access gate + reverse proxy** in front of one target site
(`https://annas-archive.gl` by default), plus a thin **Android client** that is
assembled into debug and release APKs by GitHub Actions.

The wrapper does not restyle, redesign, mirror or modify the target site. It
either forwards a request unchanged, or answers `403` — nothing else.

```
Browser / APK ──▶ Gateway (Node.js + Express) ──▶ target site
                    │
                    └─ 403 unless the URL contains the required
                       14-character sequence inside a 17-character span
```

---

## 1. The rule

| Setting | Value |
| --- | --- |
| Target site | `https://annas-archive.gl` |
| Required sequence | `annas-arichive` (14 characters, contains a dash) |
| Maximum span | `17` characters, counting every character between the first and last match |
| Matching | case-sensitive by default |
| Target lock | only hosts containing `annas-archive` (server **and** app) |
| In-app gateway editing | compiled out — requires a code change + rebuild |

A request is allowed only when all 14 characters appear **in that exact order**
somewhere in the requested URL (path + query string), and the distance from the
first matched character to the last matched character is **17 or fewer**
characters. Any characters may sit before, between or after the sequence.

Examples:

| URL | Span | Result |
| --- | --- | --- |
| `/search?q=dune&k=annas-arichive` | 14 | ✅ allowed |
| `/annas--arichive` | 15 | ✅ allowed |
| `/an-nas-ari-chive` | 16 | ✅ allowed |
| `/annas-an-r-ichive` | 17 | ✅ allowed |
| `/annas-an-r--ichive` | 18 | ❌ blocked |
| `/annas-archive` | – | ❌ blocked (wrong spelling, no match) |
| `/search?q=dune` | – | ❌ blocked |
| `/ANNAS-ARICHIVE` | – | ❌ blocked (case-sensitive) |

Everything else — the target site's HTML, CSS, images, cookies, redirects,
forms and downloads — is passed through as the real site serves it.

---

## 2. Configuration (the only block you need to edit)

`proxy/src/config.js`, at the top:

```js
const DEFAULTS = {
  TARGET_ORIGIN: 'https://annas-archive.gl', // target site
  ACCESS_SEQUENCE: 'annas-arichive',         // required 14-character sequence
  MAX_SEQUENCE_SPAN: 17,                     // max first-to-last distance
  CASE_SENSITIVE: true,                      // flip to false for case-insensitive
  // ...everything else has sensible defaults
};
```

Each value can also be supplied as an environment variable of the same name
(see `proxy/.env.example`), so one image can serve several deployments.

### Target lock (the wrapper cannot be pointed elsewhere)

`TARGET_ORIGIN` is not free-form. On startup the gateway checks it against

```js
ENFORCE_TARGET_ALLOWLIST: true,
ALLOWED_TARGET_HOST_MARKERS: ['annas-archive'],
```

and **refuses to start** if the host does not contain `annas-archive`:

```
$ TARGET_ORIGIN=https://example.com npm start
refusing to start: Target lock: TARGET_ORIGIN "https://example.com" is not an
allowed Anna's Archive host. The host must contain one of: annas-archive. ...
```

So `annas-archive.gl`, `www.annas-archive.gl`, `annas-archive.org`,
`annas-archive.se`, or your own wrapper host if it contains `annas-archive`
(e.g. `annas-archive-gateway.example.com`) all work — anything else is refused,
and a mis-set environment variable fails closed instead of silently proxying a
different site.

### Making the check case-insensitive

Set `CASE_SENSITIVE: false` in `proxy/src/config.js` (or
`CASE_SENSITIVE=false` in the environment). Nothing else changes: the span limit
still applies, so `ANNAS--ARICHIVE` is accepted while `ANNAS-AN-R--ICHIVE` is
not. This is a one-line, documented switch — no code edits required.

---

## 3. Run the gateway locally

Requirements: Node.js ≥ 18.17 (tested on 20 and 22).

```bash
cd proxy
npm install
npm start                       # http://0.0.0.0:8080
```

Then open, for example:

```
http://localhost:8080/                          → 403 Access blocked
http://localhost:8080/?gateway=annas-arichive   → the site's home page
http://localhost:8080/search?q=dune&gateway=annas-arichive
```

Options:

```bash
PORT=3000 npm start
TARGET_ORIGIN=https://another-mirror.example npm start
ACCESS_SEQUENCE=my-secret npm start
MAX_SEQUENCE_SPAN=20 npm start
CASE_SENSITIVE=false npm start
```

Tests (the gateway is covered by 54 unit + integration tests against a fake
origin, including the target lock):

```bash
cd proxy
npm test
```

### Docker

```bash
cd proxy
docker build -t aa-gateway .
docker run --rm -p 8080:8080 -e TARGET_ORIGIN=https://annas-archive.gl aa-gateway
```

Any Node host works the same way (Render, Railway, Fly.io, a VPS with
`node src/index.js` behind nginx/Caddy). The server binds `0.0.0.0` and honours
`PORT`, so no extra configuration is needed.

### Pointing the wrapper at the site

Only `TARGET_ORIGIN` matters: the gateway keeps the request path and query
string and swaps the scheme/host. Redirects, cookies and links that point at the
target's own origin are mapped back onto the gateway host, so the browser stays
on the wrapper.

---

## 4. How it behaves

* **The upstream origin is always taken from configuration**, never from the
  request, so absolute-form targets (`GET http://elsewhere/x`), protocol-relative
  targets and backslash tricks cannot turn the gateway into an open proxy.
* **Validation is 100 % server-side.** Client JavaScript is never consulted, and
  disabling JavaScript, using `curl`, or hitting the port with a bot changes
  nothing.
* **Blocked requests** return `403` with
  `Access blocked: required access sequence not found.`, plus
  `Cache-Control: no-store`.
* **Allowed requests** are streamed to the target with the browser's own headers
  (Host/Referer/Origin re-pointed at the target) and the response is streamed
  back. Bodies are never stored on disk and never cached by the gateway.
* **The access parameter is stripped before forwarding**
  (`STRIP_TOKEN_BEFORE_FORWARDING`), so the target site sees the clean URL it
  would have seen without the wrapper.
* **Navigation keeps working**: links, assets, form actions and `Location`
  headers get the sequence appended (URLs only — no markup, text or styling is
  changed). Links produced by JavaScript at runtime are handled by the Android
  client, which re-adds the sequence before loading them.
* **Cookies** are re-scoped to the wrapper host (Domain removed, Secure dropped
  when the wrapper runs on plain http, `SameSite=None` downgraded to `Lax` in
  that case only).
* **Response headers that would break proxying** (CSP, HSTS, X-Frame-Options,
  Alt-Svc) are removed; everything else is forwarded untouched.
* **Audit logging is deliberately minimal.** Per request: timestamp, event,
  method, URL *length* and a truncated SHA-256 *hash* of the URL. No paths, no
  query strings, no headers, no bodies, no response content, nothing cached.
  Disable it entirely with `AUDIT_LOG=false`.

### Strict mode (byte-for-byte passthrough)

With `REWRITE_LINKS: false` the gateway never touches a response body or URL —
the site's bytes come out exactly as they went in. The trade-off: every single
request (including assets and links the site generates) must then carry the
sequence yourself.

---

## 5. Android client (debug + release APK)

`android/` is a minimal, dependency-free WebView client (no AndroidX, no
third-party libraries except JUnit for the unit tests). It appends the access
sequence to navigations the page triggers itself, keeps cookies/session state,
and hands downloads to the system `DownloadManager` (with cookies and the
sequence attached).

### The app is locked too

`GatewayPolicy.java` is the single place that decides what the app may load:

```java
static final boolean ALLOW_IN_APP_GATEWAY_EDITING = false; // menu editor is compiled out
static final boolean ALLOW_NON_ANNA_ARCHIVE_HOSTS = false; // host must contain "annas-archive"
private static final String[] ALLOWED_HOST_MARKERS = {"annas-archive"};
```

While `ALLOW_IN_APP_GATEWAY_EDITING` is `false`:

* **Gateway settings** in the menu only shows an explanation — it does not open
  the editor.
* Any gateway URL saved by an earlier build is **ignored and deleted**; the URL
  compiled into the APK always wins.
* There is no hidden gesture, intent, deep link, preference or runtime toggle
  that unlocks it. The only way in is editing `GatewayPolicy.java`, setting the
  flag to `true`, and rebuilding the APK.

The settings-dialog code is untouched and still fully functional once the flag
is flipped. `GatewayPolicyTest` (run in CI) asserts that editing stays compiled
out and that non-Anna's Archive hosts are refused, so flipping the flag
carelessly fails the build.

The host rule applies in both modes: `annas-archive.gl`,
`www.annas-archive.gl`, `annas-archive.org` … and a self-hosted wrapper host
such as `annas-archive-gateway.example.com` are accepted; everything else
(including `127.0.0.1` and `annasarchive.gl` without the dash) is rejected. If
you ever need to point a build at something else completely, also set
`ALLOW_NON_ANNA_ARCHIVE_HOSTS = true`.

> Local testing caveat: a gateway running on `http://127.0.0.1:8080` does not
> contain `annas-archive`, so the app refuses it. Test in a desktop browser,
> build with `-PgatewayUrl=http://annas-archive.localhost:8080/`, or flip
> `ALLOW_NON_ANNA_ARCHIVE_HOSTS` in your own test build.

Default values are compiled in and can be changed per build (developer side —
not from inside the app):

```bash
cd android
# the APK default is https://annas-archive.gl/ ; point it at your own wrapper
# (host must contain "annas-archive", otherwise the app refuses it)
gradle assembleDebug -PgatewayUrl=https://annas-archive-gateway.example.com/ \
                     -PaccessSequence=annas-arichive
```

The same value can be set for CI runs with the `gateway_url` workflow-dispatch
input.

### Building the APKs

Local (needs JDK 17 and Gradle 8.7+; no Android SDK needed on CI):

```bash
cd android
gradle assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
gradle assembleRelease          # unsigned unless keystore.properties exists
```

Signing: copy `android/keystore.properties.example` to
`android/keystore.properties`, put your keystore next to it and fill in the
passwords. Without that file the release APK builds but is unsigned.

### GitHub Actions

`.github/workflows/ci.yml` runs on every push:

1. `Gateway tests` — `npm ci && npm test` in `proxy/`.
2. `Android APKs` — creates an ephemeral signing key, runs
   `gradle assembleDebug` and `gradle assembleRelease`, verifies both APKs with
   `apksigner`, uploads them as workflow artifacts, and publishes them to the
   **`apk-latest`** GitHub release.

Download them from any of these places:

* `apk/aa-gateway-debug.apk` and `apk/aa-gateway-release.apk` in this branch — the
  workflow commits each build back to the branch, so a plain `git pull` is enough;
* the workflow run's *Artifacts* section;
* *Releases → AA Gateway APKs* (tag `apk-latest`).

```bash
adb install -r apk/aa-gateway-release.apk     # release build
adb install -r apk/aa-gateway-debug.apk       # debug build (package suffix .debug)
```

Both are signed with APK Signature Scheme v2 and install on Android 7.0 (API 24)
and newer. The app opens straight to the gateway compiled into the build — it
does not ask for a URL, because that editor is locked (see above).

> The CI signing key is generated per run (unless you set the
> `ANDROID_KEYSTORE_PASSWORD` secret plus commit your own keystore). Because the
> key changes between runs, Android will not install a new build as an update
> over an older one — uninstall first, or use your own keystore for real
> distribution.

---

## 6. Limitations and caveats

* **Login and sessions.** Form logins generally work (cookies are re-scoped and
  POST bodies forwarded), but sites that pin cookies to an exact domain, use
  `__Host-`/`__Secure-` cookie prefixes, or bind sessions to the TLS client
  fingerprint may break.
* **JavaScript-heavy client routing.** Absolute URLs generated at runtime
  (`fetch('/api/x')`, `history.pushState`, service workers) bypass the HTML
  rewrite. The Android client compensates for top-level navigations; arbitrary
  in-page `fetch` calls to un-tokened URLs will still receive the gateway's 403.
  Deep SPA support would require injecting a script into the page — that would
  modify the site, so it is intentionally not done.
* **Anti-bot / proxy blocking.** Cloudflare, CAPTCHAs, IP reputation and
  bot-detection heuristics treat datacenter IPs (and proxies) differently. The
  gateway forwards the browser's own User-Agent and does **not** spoof
  fingerprints, solve challenges, or rotate identities. If the target blocks
  your gateway's IP, the gateway will faithfully return the block page.
* **WebSockets / HTTP/2 push / Server-Sent Events** are not proxied (plain
  HTTP/1.1 request/response only). Long-polling over normal requests works.
* **Absolute third-party assets** are left pointing at their own origin (the
  gateway proxies one site, not the whole web), so they load directly from
  their original host; strict CSPs on those hosts can therefore behave
  differently than on the original page.
* **Downloads** are streamed through the gateway and never stored server-side.
* **Terms of service and law.** Proxying or mirroring a site may violate its
  terms of service, robots policy, and — depending on the site and your
  jurisdiction — copyright or anti-circumvention law. This gateway gives you no
  rights you did not already have, does not remove the target's own access
  controls, paywalls or rate limits, and is meant for hosts you are authorised
  to gate. You are responsible for what you point it at and who you give the
  sequence to.
* **The lock is a build-time lock, not DRM.** `ALLOW_IN_APP_GATEWAY_EDITING` is
  a constant inside the APK: anyone who modifies and re-signs the app can change
  it, and the server-side target lock is what actually keeps a *deployed
  gateway* pinned to Anna's Archive. The in-app lock keeps ordinary users from
  re-pointing the client, not a determined reverse engineer.
* **One shared secret, no user accounts.** Anyone with the sequence can use the
  gateway. Put it behind TLS (a platform proxy or Caddy/nginx), keep logs
  minimal (they are), and rotate by changing `ACCESS_SEQUENCE`.

---

## 7. Repository layout

```
proxy/                 server-side gateway (Node.js + Express)
  src/config.js        ← the configuration block
  src/access.js        ordered-subsequence + span matcher
  src/rewrite.js       link/cookie/redirect rewriting (URLs only)
  src/server.js        validation gate + streaming reverse proxy
  src/index.js         process entry point
  test/                access, rewrite and end-to-end proxy tests
  Dockerfile
android/               Android client (Java, no third-party dependencies)
.github/workflows/     CI: tests + debug/release APK build and release
```
