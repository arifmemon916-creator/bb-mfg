package tech.bbmfg.bizbill;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.RequiresApi;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.fragment.app.FragmentActivity;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Locale;

/**
 * Hosts the BizBill web app in a locked-down WebView.
 *
 *  - Content is served ONLY from the APK assets through WebViewAssetLoader at
 *    https://appassets.androidplatform.net/assets/www/ (Google's recommended
 *    secure replacement for file:///android_asset/). File and content access
 *    are disabled completely.
 *  - Every network request that is not an app asset is refused, and every
 *    navigation away from the app is blocked; allowlisted links (tel:, mailto:,
 *    WhatsApp, a few https hosts) are handed to other apps instead.
 *  - The JavaScript bridge only answers while BizBill's own page is loaded.
 *  - A crashed / killed WebView renderer is recreated automatically.
 */
public class MainActivity extends FragmentActivity {
    private FrameLayout root;
    private WebView webView;
    private NativeBridge bridge;
    private WebViewAssetLoader assetLoader;
    private volatile boolean trustedPage;
    private boolean pageReady;
    private String pendingRoute;
    private boolean fullscreen;
    private final long[] crashTimes = new long[3];
    private int crashIndex;

    // File chooser (photo picker / camera / documents)
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private ActivityResultLauncher<PickVisualMediaRequest> photoPicker;
    private ActivityResultLauncher<Uri> takePicture;
    private ActivityResultLauncher<String[]> openDocument;
    // Save (Storage Access Framework)
    private ActivityResultLauncher<Intent> createDocument;
    private byte[] pendingSave;
    private SaveResult pendingSaveResult;
    // Notification permission
    private ActivityResultLauncher<String> notificationPermission;
    private PermissionResult pendingPermission;

    interface SaveResult {
        void done(boolean success, String error);
    }

    interface PermissionResult {
        void done(boolean granted);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        long start = SystemClock.uptimeMillis();
        splash.setKeepOnScreenCondition(() -> !pageReady && SystemClock.uptimeMillis() - start < 4000);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        root = new FrameLayout(this);
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.window_bg));
        setContentView(root);
        applyInsets();
        registerLaunchers();
        handleIntent(getIntent());

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBack();
            }
        });

        // Copy data left by an older file:// build (once), then start the app.
        LegacyDataExporter.runIfNeeded(this, this::createWebView);
    }

    // ------------------------------------------------------------------ WebView

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createWebView() {
        if (isFinishing() || isDestroyed()) return;
        try {
            webView = new WebView(this);
        } catch (RuntimeException e) {
            // WebView package missing / being updated.
            Log.w("WebView unavailable", e);
            showFatal(getString(R.string.error_webview));
            return;
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.window_bg));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);              // the app is JavaScript
        s.setDomStorageEnabled(true);              // localStorage for small preferences
        s.setAllowFileAccess(false);               // nothing is loaded from file://
        s.setAllowContentAccess(false);            // no content:// loading
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE); // assets come from the APK
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(SafeUrl.APP_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (SafeUrl.isAppUrl(u)) {
                    WebResourceResponse r = assetLoader.shouldInterceptRequest(u);
                    if (r != null) return r;
                }
                // Block every other request (network, other paths) inside the WebView.
                return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (SafeUrl.isAppUrl(u) && request.isForMainFrame()) return false;
                if (request.hasGesture()) {
                    Uri ext = SafeUrl.external(u.toString());
                    if (ext != null) openExternal(ext);
                }
                return true; // never navigate the app WebView anywhere else
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                trustedPage = url != null && SafeUrl.isAppUrl(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                trustedPage = url != null && SafeUrl.isAppUrl(Uri.parse(url));
                pageReady = true;
                deliverPendingRoute();
            }

            @RequiresApi(26)
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The renderer crashed or was killed for memory. Data lives in
                // IndexedDB on disk, so recreating the WebView is safe.
                Log.w("renderer gone, crashed=" + detail.didCrash(), null);
                recoverFromRendererLoss();
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return showFileChooser(callback, params);
            }

            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                request.deny(); // no camera / microphone access from the web layer
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, android.webkit.GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                if (BuildConfig.DEBUG) Log.d("console: " + m.message());
                return true;
            }
        });

        bridge = new NativeBridge(this);
        webView.addJavascriptInterface(bridge, "BizBillNative");
        root.addView(webView, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.loadUrl(SafeUrl.START_URL);
    }

    private void recoverFromRendererLoss() {
        long now = SystemClock.elapsedRealtime();
        crashTimes[crashIndex++ % crashTimes.length] = now;
        destroyWebView();
        boolean looping = crashIndex >= crashTimes.length && now - minTime() < 60_000;
        if (looping) {
            showFatal(getString(R.string.error_generic));
        } else {
            createWebView();
        }
    }

    private long minTime() {
        long m = Long.MAX_VALUE;
        for (long t : crashTimes) m = Math.min(m, t);
        return m;
    }

    private void destroyWebView() {
        trustedPage = false;
        if (webView != null) {
            root.removeView(webView);
            webView.removeJavascriptInterface("BizBillNative");
            webView.destroy();
            webView = null;
        }
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
    }

    private void showFatal(String message) {
        TextView tv = new TextView(this);
        tv.setText(message);
        tv.setTextSize(18);
        tv.setPadding(48, 48, 48, 48);
        tv.setTextColor(ContextCompat.getColor(this, R.color.brand));
        root.removeAllViews();
        root.addView(tv);
        pageReady = true;
    }

    boolean isTrustedPage() {
        return trustedPage;
    }

    /** Resolve an async bridge call. Values are JSON-quoted, never concatenated raw. */
    void resolveCallback(String cb, String json) {
        if (!InputGuard.isCallback(cb)) return;
        runOnUiThread(() -> evaluate("window.BizBillBridge&&window.BizBillBridge.resolve(" + JSONObject.quote(cb) + "," + JSONObject.quote(json) + ")"));
    }

    void reportUpdateProgress(int pct) {
        runOnUiThread(() -> evaluate("window.BizBillBridge&&window.BizBillBridge.onUpdateProgress&&window.BizBillBridge.onUpdateProgress(" + Math.max(0, Math.min(100, pct)) + ")"));
    }

    private void evaluate(String js) {
        if (webView != null && trustedPage) webView.evaluateJavascript(js, null);
    }

    // ------------------------------------------------------------------ back / lifecycle / deep links

    private void onBack() {
        if (webView == null || !trustedPage) {
            moveTaskToBack(true);
            return;
        }
        webView.evaluateJavascript("(function(){try{return !!(window.BizBillBridge&&window.BizBillBridge.onBack&&window.BizBillBridge.onBack());}catch(e){return false;}})()",
                value -> {
                    if (!"true".equals(value)) moveTaskToBack(true);
                });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
        deliverPendingRoute();
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra(Notifications.EXTRA_ROUTE);
        if (InputGuard.isRoute(route)) pendingRoute = route;
    }

    private void deliverPendingRoute() {
        if (pendingRoute == null || !pageReady || webView == null) return;
        String r = pendingRoute;
        pendingRoute = null;
        // Give the app a moment to boot (it also checks the route itself).
        webView.postDelayed(() -> evaluate("window.BizBillBridge&&window.BizBillBridge.openRoute&&window.BizBillBridge.openRoute(" + JSONObject.quote(r) + ")"), 600);
    }

    @Override
    protected void onPause() {
        evaluate("window.BizBillBridge&&window.BizBillBridge.onLifecycle&&window.BizBillBridge.onLifecycle('pause')");
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        evaluate("window.BizBillBridge&&window.BizBillBridge.onLifecycle&&window.BizBillBridge.onLifecycle('resume')");
        if (fullscreen) setFullscreen(true);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // WebView is kept across rotation / theme changes; the page listens to
        // prefers-color-scheme itself.
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.window_bg));
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ window / system bars

    private void applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            int bottom = Math.max(bars.bottom, ime.bottom);
            if (fullscreen) v.setPadding(0, 0, 0, ime.bottom);
            else v.setPadding(bars.left, bars.top, bars.right, bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    void setFullscreen(boolean on) {
        fullscreen = on;
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (on) {
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
        }
        ViewCompat.requestApplyInsets(root);
    }

    void setSecureScreen(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @SuppressWarnings("deprecation")
    void setSystemBars(String color, boolean dark) {
        int c = Color.parseColor(color);
        root.setBackgroundColor(c);
        if (Build.VERSION.SDK_INT < 35) getWindow().setStatusBarColor(c);
        WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ctl.setAppearanceLightStatusBars(false);
        ctl.setAppearanceLightNavigationBars(!dark);
    }

    void openExternal(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        Intent i = "tel".equals(scheme) ? new Intent(Intent.ACTION_DIAL, u)
                : "mailto".equals(scheme) ? new Intent(Intent.ACTION_SENDTO, u)
                : new Intent(Intent.ACTION_VIEW, u);
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        i.setComponent(null);
        i.setSelector(null);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Log.w("no app for link", e);
        }
    }

    // ------------------------------------------------------------------ file chooser, save, permissions

    private void registerLaunchers() {
        photoPicker = registerForActivityResult(new ActivityResultContracts.PickVisualMedia(), uri -> deliverFiles(uri == null ? null : new Uri[]{uri}));
        takePicture = registerForActivityResult(new ActivityResultContracts.TakePicture(), success -> deliverFiles(success && cameraUri != null ? new Uri[]{cameraUri} : null));
        openDocument = registerForActivityResult(new ActivityResultContracts.OpenDocument(), uri -> deliverFiles(uri == null ? null : new Uri[]{uri}));
        createDocument = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            byte[] data = pendingSave;
            SaveResult cb = pendingSaveResult;
            pendingSave = null;
            pendingSaveResult = null;
            if (cb == null) return;
            Uri uri = result.getData() == null ? null : result.getData().getData();
            if (result.getResultCode() != RESULT_OK || uri == null || data == null) {
                cb.done(false, "cancelled");
                return;
            }
            try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("no stream");
                out.write(data);
                cb.done(true, null);
            } catch (IOException | SecurityException e) {
                Log.w("save failed", e);
                cb.done(false, "The file could not be saved (storage full or location not writable)");
            }
        });
        notificationPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            PermissionResult cb = pendingPermission;
            pendingPermission = null;
            if (cb != null) cb.done(granted);
        });
    }

    private boolean showFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        String[] accept = params.getAcceptTypes();
        boolean imagesOnly = accept != null && accept.length > 0;
        boolean wantsPdf = false;
        if (accept != null) {
            for (String a : accept) {
                String t = a == null ? "" : a.trim().toLowerCase(Locale.ROOT);
                if (t.isEmpty()) { imagesOnly = false; continue; }
                for (String part : t.split(",")) {
                    part = part.trim();
                    if (part.equals("application/pdf") || part.equals(".pdf")) wantsPdf = true;
                    if (!part.startsWith("image/")) imagesOnly = false;
                }
            }
        }
        try {
            if (imagesOnly && params.isCaptureEnabled()) {
                File f = new File(FileStore.cameraDir(this), "photo-" + System.currentTimeMillis() + ".jpg");
                cameraUri = FileProvider.getUriForFile(this, getPackageName() + ".files", f);
                takePicture.launch(cameraUri);
            } else if (imagesOnly) {
                photoPicker.launch(new PickVisualMediaRequest.Builder()
                        .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE).build());
            } else if (wantsPdf) {
                openDocument.launch(new String[]{"application/pdf"});
            } else {
                // Backups (JSON) and CSV imports.
                openDocument.launch(new String[]{"application/json", "text/csv", "text/comma-separated-values", "text/plain", "application/octet-stream"});
            }
            return true;
        } catch (ActivityNotFoundException | IllegalArgumentException e) {
            Log.w("file chooser failed", e);
            deliverFiles(null);
            return false;
        }
    }

    private void deliverFiles(Uri[] uris) {
        if (fileCallback != null) fileCallback.onReceiveValue(uris);
        fileCallback = null;
    }

    void saveDocument(String name, String mime, byte[] data, SaveResult cb) {
        if (pendingSaveResult != null) pendingSaveResult.done(false, "cancelled");
        pendingSave = data;
        pendingSaveResult = cb;
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name);
        try {
            createDocument.launch(i);
        } catch (ActivityNotFoundException e) {
            pendingSave = null;
            pendingSaveResult = null;
            cb.done(false, "No file manager available on this device");
        }
    }

    void requestNotificationPermission(PermissionResult cb) {
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            cb.done(Notifications.enabled(this));
            return;
        }
        pendingPermission = cb;
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS);
    }

    void openNotificationSettings(boolean fullScreen) {
        Intent i;
        if (fullScreen && Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName()));
        } else if (Build.VERSION.SDK_INT >= 26) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
        }
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
        }
    }
}
