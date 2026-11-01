package io.aagateway.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The app is locked to Anna's Archive hosts, and in-app editing is compiled out.
 * These tests pin both properties down so a future change cannot silently
 * re-open the gateway editor or allow an unrelated host.
 */
public class GatewayPolicyTest {

    @Test
    public void annasArchiveHostsAreAllowed() {
        assertTrue(GatewayPolicy.isAllowed("https://annas-archive.gl/"));
        assertTrue(GatewayPolicy.isAllowed("https://annas-archive.gl"));
        assertTrue(GatewayPolicy.isAllowed("https://www.annas-archive.gl"));
        assertTrue(GatewayPolicy.isAllowed("https://annas-archive.org/"));
        assertTrue(GatewayPolicy.isAllowed("https://annas-archive.se/"));
        assertTrue(GatewayPolicy.isAllowed("http://annas-archive.gl:8080/"));
        assertTrue(GatewayPolicy.isAllowed("https://annas-archive-gateway.example.com/"));
        assertTrue(GatewayPolicy.isAllowed("https://AnNaS-ArChIvE.gl/"));
        // a bare host is normalised like a browser would
        assertTrue(GatewayPolicy.isAllowed("annas-archive.gl"));
    }

    @Test
    public void unrelatedHostsAreRefused() {
        assertFalse(GatewayPolicy.isAllowed("https://example.com"));
        assertFalse(GatewayPolicy.isAllowed("https://google.com/search?q=annas-archive"));
        assertFalse(GatewayPolicy.isAllowed("https://annasarchive.gl"));
        assertFalse(GatewayPolicy.isAllowed("https://evil.example/annas-archive.gl"));
        assertFalse(GatewayPolicy.isAllowed("http://127.0.0.1:8080/"));
        assertFalse(GatewayPolicy.isAllowed("file:///etc/hosts"));
        assertFalse(GatewayPolicy.isAllowed("javascript:alert(1)"));
        assertFalse(GatewayPolicy.isAllowed("https://user:pass@annas-archive.gl/"));
        assertFalse(GatewayPolicy.isAllowed(""));
        assertFalse(GatewayPolicy.isAllowed(null));
    }

    @Test
    public void settingsEditorIsCompiledOutOfThisBuild() {
        assertFalse("in-app gateway editing must stay disabled", GatewayPolicy.isEditingAllowed());
        assertFalse("the host allowlist must not be bypassable", GatewayPolicy.ALLOW_NON_ANNA_ARCHIVE_HOSTS);
    }

    @Test
    public void storedUrlIsIgnoredWhileEditingIsLocked() {
        String resolved = GatewayPolicy.resolveGatewayUrl("https://evil.example/");
        assertTrue(GatewayPolicy.isAllowed(resolved));
        assertNotEquals("https://evil.example/", resolved);

        // Even an allowed-looking stored value must not win while the lock is on.
        String resolvedAllowed = GatewayPolicy.resolveGatewayUrl("https://www.annas-archive.org/");
        if (!GatewayPolicy.isEditingAllowed()) {
            assertEquals(GatewayPolicy.resolveGatewayUrl(null), resolvedAllowed);
        }
    }

    @Test
    public void resolveAlwaysReturnsAnAllowedUrl() {
        String[] inputs = {
                null, "", "https://example.com", "https://annas-archive.gl/", "junk", "https://192.168.0.10/"
        };
        for (String input : inputs) {
            assertTrue("input: " + input, GatewayPolicy.isAllowed(GatewayPolicy.resolveGatewayUrl(input)));
        }
    }

    @Test
    public void normalizeAddsScheme() {
        assertEquals("https://annas-archive.gl", GatewayPolicy.normalize("annas-archive.gl"));
        assertEquals("http://annas-archive.gl", GatewayPolicy.normalize("http://annas-archive.gl"));
        assertEquals(null, GatewayPolicy.normalize(null));
    }
}
