package tech.bbmfg.bizbill;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Data migration from older BizBill builds that loaded the app from
 * file:///android_asset/ and therefore stored invoices, customers etc. in
 * WebView storage for the file:// origin. The new app runs on a secure
 * https asset origin, which cannot see that storage.
 *
 * On first launch after the update this class loads a tiny read-only page
 * in a separate, hidden WebView (file access enabled for THAT WebView only),
 * copies whatever it finds into files/legacy/legacy-data.json and records
 * the result. The original storage is never modified or deleted, so the
 * process can be repeated and nothing can be lost.
 */
final class LegacyDataExporter {
    private LegacyDataExporter() {}

    private static final String PREFS = "legacy";
    private static final int MAX_ATTEMPTS = 3;
    private static final long TIMEOUT_MS = 20000;

    static File dataFile(Context c) {
        return new File(FileStore.legacyDir(c), "legacy-data.json");
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String info(Context c) {
        File f = dataFile(c);
        try {
            return new JSONObject()
                    .put("found", f.exists() && f.length() > 0)
                    .put("imported", prefs(c).getBoolean("imported", false))
                    .put("size", f.exists() ? f.length() : 0)
                    .toString();
        } catch (JSONException e) {
            return "{\"found\":false}";
        }
    }

    static String read(Context c) {
        File f = dataFile(c);
        if (!f.exists() || f.length() > InputGuard.MAX_BACKUP_CHARS) return null;
        try {
            return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    static void markImported(Context c) {
        prefs(c).edit().putBoolean("imported", true).apply();
    }

    /** Run once (retried up to 3 launches if it fails). Must be called on the main thread. */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    static void runIfNeeded(Activity activity, Runnable done) {
        SharedPreferences p = prefs(activity);
        if (p.getBoolean("checked", false) || p.getInt("attempts", 0) >= MAX_ATTEMPTS) {
            done.run();
            return;
        }
        p.edit().putInt("attempts", p.getInt("attempts", 0) + 1).apply();
        final WebView wv;
        try {
            wv = new WebView(activity.getApplicationContext());
        } catch (RuntimeException e) {
            Log.w("legacy export: no WebView", e);
            done.run();
            return;
        }
        final Handler h = new Handler(Looper.getMainLooper());
        final boolean[] finished = {false};
        final Runnable finish = () -> {
            if (finished[0]) return;
            finished[0] = true;
            try {
                wv.removeJavascriptInterface("LegacyExport");
                wv.destroy();
            } catch (RuntimeException ignored) {
                // already gone
            }
            done.run();
        };
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Needed to reach the old file:// origin; this WebView loads nothing else.
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setBlockNetworkLoads(true);
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // no navigation at all
            }
        });
        wv.addJavascriptInterface(new ExportBridge(activity.getApplicationContext(), () -> h.post(finish)), "LegacyExport");
        wv.loadUrl("file:///android_asset/legacy/export.html");
        h.postDelayed(finish, TIMEOUT_MS);
    }

    static final class ExportBridge {
        private final Context ctx;
        private final Runnable onDone;
        private boolean used;

        ExportBridge(Context ctx, Runnable onDone) {
            this.ctx = ctx;
            this.onDone = onDone;
        }

        @JavascriptInterface
        public void deliver(String json) {
            synchronized (this) {
                if (used) return;
                used = true;
            }
            try {
                if (json != null && json.length() <= InputGuard.MAX_BACKUP_CHARS) {
                    JSONObject o = new JSONObject(json);
                    JSONObject ls = o.optJSONObject("localStorage");
                    JSONObject idb = o.optJSONObject("indexedDB");
                    boolean hasData = (ls != null && ls.length() > 0) || (idb != null && idb.length() > 0);
                    File f = dataFile(ctx);
                    // Never replace an earlier copy with an empty one.
                    if (hasData && (!f.exists() || f.length() == 0)) FileStore.writeAtomically(f, json);
                    prefs(ctx).edit().putBoolean("checked", true).putBoolean("hadData", hasData).apply();
                }
            } catch (JSONException | IOException e) {
                Log.w("legacy export failed", e);
            } finally {
                onDone.run();
            }
        }
    }
}
