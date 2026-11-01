package io.aagateway.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.util.Locale;

/**
 * Thin, native client for the access-gated gateway.
 *
 * The app does no access control of its own: every request it makes is checked
 * by the gateway on the server. It only remembers the gateway URL, keeps the
 * access sequence on navigations the page performs itself, and renders whatever
 * the gateway returns in a normal WebView.
 */
public class MainActivity extends Activity {

    private static final String TAG = "AAGateway";
    private static final String PREFS = "gateway_prefs";
    private static final String PREF_GATEWAY_URL = "gateway_url";
    private static final String PREF_ACCESS_SEQUENCE = "access_sequence";

    private static final int MENU_RELOAD = 1;
    private static final int MENU_HOME = 2;
    private static final int MENU_SETTINGS = 3;

    private WebView webView;
    private SharedPreferences prefs;
    private String gatewayUrl;
    private String accessSequence;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        // The gateway is locked at build time (see GatewayPolicy). While editing
        // is disabled the stored value is deliberately ignored and the URL
        // compiled into the APK is always used.
        String storedGateway = prefs.getString(PREF_GATEWAY_URL, null);
        gatewayUrl = GatewayPolicy.resolveGatewayUrl(storedGateway);
        accessSequence = prefs.getString(PREF_ACCESS_SEQUENCE, BuildConfig.ACCESS_SEQUENCE);

        if (storedGateway != null && !storedGateway.equals(gatewayUrl)) {
            Log.i(TAG, "Ignoring stored gateway URL: the gateway is locked in this build.");
            prefs.edit().remove(PREF_GATEWAY_URL).apply();
        }

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWebView(webView);
        setContentView(webView);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else if (GatewayPolicy.isEditingAllowed() && storedGateway == null) {
            // Only reachable in a build where editing has been unlocked again.
            showSettingsDialog(true);
        } else {
            loadHome();
        }
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        // The gateway may be served over plain http on a LAN during testing.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(view, true);

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG_BUILD);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return handleNavigation(v, request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return handleNavigation(v, Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (getActionBar() != null) {
                    getActionBar().setSubtitle(v.getTitle());
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient());

        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                // Downloads are issued by the system DownloadManager, so the
                // access sequence and cookies have to be attached explicitly.
                String downloadUrl = withAccessSequence(url);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(downloadUrl));
                String cookies = CookieManager.getInstance().getCookie(downloadUrl);
                if (cookies != null && !cookies.isEmpty()) {
                    request.addRequestHeader("Cookie", cookies);
                }
                if (userAgent != null) {
                    request.addRequestHeader("User-Agent", userAgent);
                }
                String fileName = URLUtil.guessFileName(downloadUrl, contentDisposition, mimeType);
                request.setTitle(fileName);
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalFilesDir(
                        MainActivity.this, Environment.DIRECTORY_DOWNLOADS, fileName);

                DownloadManager manager =
                        (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (manager == null) {
                    toast("Download manager unavailable");
                    return;
                }
                manager.enqueue(request);
                toast("Download started: " + fileName);
            } catch (Exception error) {
                toast("Download failed: " + error.getMessage());
            }
        });
    }

    /** Keep browsing on the gateway host; everything else leaves the app. */
    private boolean handleNavigation(WebView view, Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);

        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // No handler installed for this scheme.
            }
            return true;
        }

        if (isGatewayHost(uri)) {
            String url = uri.toString();
            if (!url.contains(accessSequence)) {
                // A link or script produced a URL without the sequence: add it
                // so the gateway lets the request through.
                view.loadUrl(withAccessSequence(url));
                return true;
            }
            return false;
        }

        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            toast("No app can open " + uri.getHost());
        }
        return true;
    }

    private boolean isGatewayHost(Uri uri) {
        if (gatewayUrl == null) return false;
        try {
            Uri gateway = Uri.parse(gatewayUrl);
            String targetHost = gateway.getHost();
            return targetHost != null && targetHost.equalsIgnoreCase(uri.getHost());
        } catch (Exception error) {
            return false;
        }
    }

    /** Ensure the access sequence is present in a URL. */
    private String withAccessSequence(String url) {
        if (url == null) return null;
        if (accessSequence == null || accessSequence.isEmpty()) return url;
        if (url.contains(accessSequence)) return url;

        String fragment = "";
        String head = url;
        int hashIndex = url.indexOf('#');
        if (hashIndex >= 0) {
            fragment = url.substring(hashIndex);
            head = url.substring(0, hashIndex);
        }

        String separator;
        if (!head.contains("?")) {
            separator = "?";
        } else if (head.endsWith("?") || head.endsWith("&")) {
            separator = "";
        } else {
            separator = "&";
        }

        return head + separator + BuildConfig.ACCESS_PARAM + "="
                + Uri.encode(accessSequence) + fragment;
    }

    private void loadHome() {
        if (!GatewayPolicy.isAllowed(gatewayUrl)) {
            // Cannot happen with the shipped build (the policy falls back to the
            // canonical site), but never load a non-Anna's Archive host.
            gatewayUrl = GatewayPolicy.resolveGatewayUrl(null);
        }
        webView.loadUrl(withAccessSequence(gatewayUrl));
    }

    /** Shown by the (compiled-out) settings entry while the lock is in place. */
    private void showLockedDialog() {
        new AlertDialog.Builder(this)
                .setTitle("Gateway settings are locked")
                .setMessage("This build is pinned to " + gatewayUrl + "\n\n"
                        + "The gateway editor is still in the source code, but it is disabled "
                        + "at build time. To use it you must set "
                        + "ALLOW_IN_APP_GATEWAY_EDITING = true in GatewayPolicy.java and "
                        + "rebuild the APK. There is no in-app way to unlock it.")
                .setPositiveButton("OK", (dialog, which) -> dialog.dismiss())
                .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(Menu.NONE, MENU_RELOAD, Menu.NONE, "Reload");
        menu.add(Menu.NONE, MENU_HOME, Menu.NONE, "Gateway home");
        menu.add(Menu.NONE, MENU_SETTINGS, Menu.NONE, "Gateway settings");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case MENU_RELOAD:
                webView.reload();
                return true;
            case MENU_HOME:
                loadHome();
                return true;
            case MENU_SETTINGS:
                if (GatewayPolicy.isEditingAllowed()) {
                    showSettingsDialog(false);
                } else {
                    showLockedDialog();
                }
                return true;
            default:
                return super.onOptionsItemSelected(item);
        }
    }

    private void showSettingsDialog(boolean firstRun) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding / 2, padding, 0);

        EditText urlField = new EditText(this);
        urlField.setHint("https://gateway.example.com/");
        urlField.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        urlField.setText(gatewayUrl);
        layout.addView(urlField);

        EditText sequenceField = new EditText(this);
        sequenceField.setHint("access sequence");
        sequenceField.setInputType(InputType.TYPE_CLASS_TEXT);
        sequenceField.setText(accessSequence);
        layout.addView(sequenceField);

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle("Gateway settings")
                .setView(layout)
                .setCancelable(!firstRun)
                .setPositiveButton("Save and load", (dialog, which) -> {
                    String url = GatewayPolicy.normalize(urlField.getText().toString());
                    String sequence = sequenceField.getText().toString().trim();
                    if (url == null || url.isEmpty()) {
                        toast("Gateway URL is required");
                        return;
                    }
                    if (!GatewayPolicy.isAllowed(url)) {
                        toast(GatewayPolicy.rejectionReason(url));
                        return;
                    }
                    gatewayUrl = url;
                    accessSequence = sequence;
                    prefs.edit()
                            .putString(PREF_GATEWAY_URL, gatewayUrl)
                            .putString(PREF_ACCESS_SEQUENCE, accessSequence)
                            .apply();
                    loadHome();
                });

        if (!firstRun) {
            builder.setNegativeButton("Cancel", (dialog, which) -> dialog.dismiss());
        }

        builder.show();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
            CookieManager.getInstance().flush();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }
}
