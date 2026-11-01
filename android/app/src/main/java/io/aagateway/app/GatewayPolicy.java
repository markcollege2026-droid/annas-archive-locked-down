package io.aagateway.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Build-time lock for the gateway the app is allowed to talk to.
 *
 * The app is pinned to Anna's Archive: a gateway URL is only accepted when its
 * host contains "annas-archive", so annas-archive.gl, www.annas-archive.gl,
 * annas-archive.org, annas-archive.se ... work, and - if you self-host the
 * wrapper - a host such as annas-archive-gateway.example.com works too.
 * Anything else is refused.
 *
 * <p>In-app editing is compiled out by default. To re-enable the settings menu
 * you must change {@link #ALLOW_IN_APP_GATEWAY_EDITING} to {@code true} below
 * and rebuild the APK; there is no runtime switch, no hidden gesture and no
 * preference that can unlock it.
 */
final class GatewayPolicy {

    /**
     * DEVELOPER SWITCH - set to {@code true} and rebuild to make the
     * "Gateway settings" menu usable again.
     *
     * <p>While this is {@code false}:
     * <ul>
     *   <li>the menu entry only explains that editing is locked,</li>
     *   <li>any gateway URL previously stored in SharedPreferences is ignored,</li>
     *   <li>the URL compiled into the APK is always used.</li>
     * </ul>
     */
    static final boolean ALLOW_IN_APP_GATEWAY_EDITING = false;

    /**
     * SECOND LOCK - even with editing unlocked, only Anna's Archive hosts are
     * accepted. Flip this too if you ever need a completely different target.
     */
    static final boolean ALLOW_NON_ANNA_ARCHIVE_HOSTS = false;

    /** A gateway host must contain one of these markers (case-insensitive). */
    private static final String[] ALLOWED_HOST_MARKERS = {"annas-archive"};

    /** Last-resort URL used when the compiled default fails the policy. */
    static final String CANONICAL_URL = "https://annas-archive.gl/";

    private GatewayPolicy() {
        // static helpers only
    }

    /** True when in-app gateway editing is available in this build. */
    static boolean isEditingAllowed() {
        return ALLOW_IN_APP_GATEWAY_EDITING;
    }

    /**
     * Decide whether a gateway URL may be used at all.
     *
     * @param url candidate URL, with or without a scheme
     * @return true when the URL is an http(s) Anna's Archive host
     */
    static boolean isAllowed(String url) {
        if (url == null) return false;

        String trimmed = url.trim();
        if (trimmed.isEmpty()) return false;

        // Tolerate a bare host ("annas-archive.gl") the way a browser would.
        if (!trimmed.contains("://")) {
            trimmed = "https://" + trimmed;
        }

        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException error) {
            return false;
        }

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return false;

        if (uri.getUserInfo() != null && !uri.getUserInfo().isEmpty()) return false;

        String host = uri.getHost();
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase(Locale.ROOT);

        if (ALLOW_NON_ANNA_ARCHIVE_HOSTS) return true;

        for (String marker : ALLOWED_HOST_MARKERS) {
            if (host.contains(marker)) return true;
        }
        return false;
    }

    /** Human-readable reason used in the (locked-down) settings UI. */
    static String rejectionReason(String url) {
        return "Only Anna's Archive gateways are allowed (the host must contain \"annas-archive\").";
    }

    /**
     * The URL the app must load.
     *
     * <p>While editing is locked the compiled default wins and any stored value
     * is ignored, so an old preference file cannot re-point the app.
     *
     * @param storedValue value previously saved in SharedPreferences (may be null)
     * @return a URL that satisfies {@link #isAllowed(String)}
     */
    static String resolveGatewayUrl(String storedValue) {
        if (ALLOW_IN_APP_GATEWAY_EDITING && isAllowed(storedValue)) {
            return storedValue.trim();
        }

        String compiled = BuildConfig.DEFAULT_GATEWAY_URL;
        if (isAllowed(compiled)) return compiled.trim();

        // The build was configured with a non-Anna's Archive URL: stay locked
        // to the canonical site rather than loading something arbitrary.
        return CANONICAL_URL;
    }

    /** Normalise a URL for display/storage (adds https:// when missing). */
    static String normalize(String url) {
        if (url == null) return null;
        String trimmed = url.trim();
        if (trimmed.isEmpty()) return trimmed;
        return trimmed.contains("://") ? trimmed : "https://" + trimmed;
    }
}
