package tech.bbmfg.bizbill;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.JavascriptInterface;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The only native API visible to the web layer (as window.BizBillNative).
 *
 * Rules applied to every method:
 *  - calls are ignored unless the WebView is showing BizBill's own asset page,
 *  - every argument is validated (type, size, allowed values),
 *  - file names are sanitised, MIME types are allowlisted, file content must
 *    match the declared type, base64 is checked before decoding,
 *  - no method opens arbitrary intents, URIs, paths or runs commands.
 */
final class NativeBridge {
    private final MainActivity activity;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    void shutdown() {
        io.shutdownNow();
    }

    private boolean trusted() {
        return activity.isTrustedPage();
    }

    private void resolve(String cb, JSONObject result) {
        activity.resolveCallback(cb, result.toString());
    }

    private void fail(String cb, String error) {
        try {
            resolve(cb, new JSONObject().put("ok", false).put("error", error));
        } catch (JSONException ignored) {
            // cannot happen
        }
    }

    private void ok(String cb, String key, Object value) {
        try {
            JSONObject o = new JSONObject().put("ok", true);
            if (key != null) o.put(key, value);
            resolve(cb, o);
        } catch (JSONException ignored) {
            // cannot happen
        }
    }

    // ------------------------------------------------------------------ share / save / print

    @JavascriptInterface
    public void shareFile(String cb, String name, String mime, String b64, String text, String subject, String target, String phone) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        String m = InputGuard.mime(mime);
        if (m == null) { fail(cb, "This file type cannot be shared"); return; }
        byte[] bytes = InputGuard.base64(b64, InputGuard.MAX_FILE_BYTES);
        if (bytes == null || !InputGuard.contentMatches(bytes, m)) { fail(cb, "The file is invalid or too large"); return; }
        String safe = InputGuard.fileName(name, m);
        String msg = InputGuard.text(text, InputGuard.MAX_TEXT);
        String subj = InputGuard.text(subject, 200);
        io.execute(() -> {
            try {
                FileStore.cleanTemp(activity, 60 * 60 * 1000L);
                File f = FileStore.newSharedFile(activity, safe);
                FileStore.write(f, bytes);
                Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", f);
                activity.runOnUiThread(() -> startShare(cb, uri, m, msg, subj, target, phone));
            } catch (IOException | IllegalArgumentException e) {
                Log.w("share failed", e);
                fail(cb, "Could not prepare the file for sharing");
            }
        });
    }

    private void startShare(String cb, Uri uri, String mime, String text, String subject, String target, String phone) {
        Intent send;
        if ("view".equals(target)) {
            send = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime);
        } else {
            send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri);
            if (!text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
            if (!subject.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, subject);
            send.setClipData(ClipData.newRawUri(subject, uri));
        }
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent launch;
        if ("whatsapp".equals(target)) {
            String pkg = installedWhatsApp();
            if (pkg == null) { fail(cb, "WhatsApp is not installed"); return; }
            send.setPackage(pkg);
            String jid = InputGuard.whatsappNumber(phone);
            if (jid != null) send.putExtra("jid", jid + "@s.whatsapp.net");
            launch = send;
        } else if ("email".equals(target)) {
            if (InputGuard.isEmail(phone)) send.putExtra(Intent.EXTRA_EMAIL, new String[]{phone});
            launch = Intent.createChooser(send, "Send by email");
        } else if ("view".equals(target)) {
            launch = Intent.createChooser(send, "Open with");
        } else {
            launch = Intent.createChooser(send, "Share");
        }
        try {
            activity.startActivity(launch);
            ok(cb, null, null);
        } catch (ActivityNotFoundException e) {
            fail(cb, "No app found to handle this file");
        }
    }

    private String installedWhatsApp() {
        for (String pkg : new String[]{"com.whatsapp", "com.whatsapp.w4b"}) {
            try {
                activity.getPackageManager().getPackageInfo(pkg, 0);
                return pkg;
            } catch (PackageManager.NameNotFoundException ignored) {
                // try next
            }
        }
        return null;
    }

    @JavascriptInterface
    public void shareText(String cb, String text, String subject, String target, String phone) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        String msg = InputGuard.text(text, InputGuard.MAX_TEXT);
        if (msg.trim().isEmpty()) { fail(cb, "Nothing to share"); return; }
        activity.runOnUiThread(() -> {
            try {
                if ("whatsapp".equals(target)) {
                    String pkg = installedWhatsApp();
                    if (pkg == null) { fail(cb, "WhatsApp is not installed"); return; }
                    String num = InputGuard.whatsappNumber(phone);
                    Intent i;
                    if (num != null) {
                        i = new Intent(Intent.ACTION_VIEW, Uri.parse("https://api.whatsapp.com/send?phone=" + num + "&text=" + Uri.encode(msg)));
                    } else {
                        i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, msg);
                    }
                    i.setPackage(pkg);
                    activity.startActivity(i);
                } else {
                    Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, msg);
                    String subj = InputGuard.text(subject, 200);
                    if (!subj.isEmpty()) i.putExtra(Intent.EXTRA_SUBJECT, subj);
                    activity.startActivity(Intent.createChooser(i, "Share"));
                }
                ok(cb, null, null);
            } catch (ActivityNotFoundException e) {
                fail(cb, "No app found to share with");
            }
        });
    }

    /** Save through the Storage Access Framework (user picks the location). */
    @JavascriptInterface
    public void saveFile(String cb, String name, String mime, String b64) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        String m = InputGuard.mime(mime);
        if (m == null) { fail(cb, "This file type cannot be saved"); return; }
        byte[] bytes = InputGuard.base64(b64, InputGuard.MAX_FILE_BYTES);
        if (bytes == null || !InputGuard.contentMatches(bytes, m)) { fail(cb, "The file is invalid or too large"); return; }
        String safe = InputGuard.fileName(name, m);
        activity.runOnUiThread(() -> activity.saveDocument(safe, m, bytes, (success, error) -> {
            if (success) ok(cb, "saved", true);
            else fail(cb, error);
        }));
    }

    @JavascriptInterface
    public void printPdf(String cb, String name, String b64) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        byte[] bytes = InputGuard.base64(b64, InputGuard.MAX_FILE_BYTES);
        if (bytes == null || !InputGuard.contentMatches(bytes, "application/pdf")) { fail(cb, "The document is invalid"); return; }
        String safe = InputGuard.fileName(name, "application/pdf");
        io.execute(() -> {
            try {
                File f = new File(FileStore.printDir(activity), safe);
                FileStore.write(f, bytes);
                activity.runOnUiThread(() -> {
                    PrintManager pm = (PrintManager) activity.getSystemService(android.content.Context.PRINT_SERVICE);
                    if (pm == null) { fail(cb, "Printing is not available on this device"); return; }
                    try {
                        pm.print(safe.replace(".pdf", ""), new PdfPrintAdapter(f, safe), new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                        ok(cb, null, null);
                    } catch (RuntimeException e) {
                        Log.w("print failed", e);
                        fail(cb, "Could not start printing");
                    }
                });
            } catch (IOException e) {
                fail(cb, "Could not prepare the document for printing");
            }
        });
    }

    // ------------------------------------------------------------------ security

    @JavascriptInterface
    public boolean canUseBiometric() {
        if (!trusted()) return false;
        int r = BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK);
        return r == BiometricManager.BIOMETRIC_SUCCESS;
    }

    @JavascriptInterface
    public void authenticateBiometric(String cb, String title) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        String t = InputGuard.text(title, 60);
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    ok(cb, null, null);
                }

                @Override
                public void onAuthenticationError(int code, CharSequence err) {
                    boolean cancelled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED;
                    fail(cb, cancelled ? "cancelled" : String.valueOf(err));
                }
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(t.isEmpty() ? "Unlock BizBill" : t)
                    .setNegativeButtonText("Use PIN")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
                    .build();
            prompt.authenticate(info);
        });
    }

    @JavascriptInterface
    public void setSecureScreen(boolean on) {
        if (!trusted()) return;
        activity.runOnUiThread(() -> activity.setSecureScreen(on));
    }

    // ------------------------------------------------------------------ notifications

    @JavascriptInterface
    public void notify(int id, String title, String body) {
        if (!trusted()) return;
        Notifications.Payload p = new Notifications.Payload();
        p.id = Math.max(0, Math.min(1_000_000, id));
        p.title = InputGuard.text(title, 120);
        p.message = InputGuard.text(body, 1000);
        Notifications.post(activity, p);
    }

    @JavascriptInterface
    public String notifyRich(String json) {
        if (!trusted()) return "false";
        try {
            return String.valueOf(Notifications.post(activity, Notifications.Payload.parse(json)));
        } catch (JSONException e) {
            return "false";
        }
    }

    @JavascriptInterface
    public void setReminderSchedule(String json) {
        if (!trusted()) return;
        try {
            ReminderScheduler.replaceAll(activity, json);
        } catch (JSONException e) {
            Log.w("bad schedule", e);
        }
    }

    @JavascriptInterface
    public void scheduleReminder(String kind, String atMillis, String title, String body) {
        if (!trusted() || !"backup".equals(kind)) return;
        long at;
        try {
            at = Long.parseLong(atMillis);
        } catch (NumberFormatException e) {
            return;
        }
        long now = System.currentTimeMillis();
        if (at < now || at > now + 400L * 86400000L) return;
        Notifications.Payload p = new Notifications.Payload();
        p.id = 4;
        p.type = "backup";
        p.title = InputGuard.text(title, 120);
        p.message = InputGuard.text(body, 500);
        p.route = "#/backup";
        try {
            ReminderScheduler.setSingle(activity, "backup", at, p);
        } catch (JSONException ignored) {
            // payload always valid
        }
    }

    @JavascriptInterface
    public void cancelReminder(String kind) {
        if (!trusted() || !"backup".equals(kind)) return;
        ReminderScheduler.remove(activity, "backup");
    }

    @JavascriptInterface
    public String getNotificationStatus() {
        if (!trusted()) return "{}";
        try {
            boolean canAsk = Build.VERSION.SDK_INT >= 33 && !Notifications.enabled(activity);
            return new JSONObject().put("enabled", Notifications.enabled(activity))
                    .put("fullScreenAllowed", Notifications.fullScreenAllowed(activity))
                    .put("canAsk", canAsk).toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    @JavascriptInterface
    public void requestNotificationPermission(String cb) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        activity.runOnUiThread(() -> activity.requestNotificationPermission(granted -> {
            try {
                resolve(cb, new JSONObject().put("ok", granted));
            } catch (JSONException ignored) {
                // cannot happen
            }
        }));
    }

    @JavascriptInterface
    public void openNotificationSettings(String kind) {
        if (!trusted()) return;
        activity.runOnUiThread(() -> activity.openNotificationSettings("fullscreen".equals(kind)));
    }

    // ------------------------------------------------------------------ display

    @JavascriptInterface
    public void setFullscreen(boolean on) {
        if (!trusted()) return;
        activity.runOnUiThread(() -> activity.setFullscreen(on));
    }

    @JavascriptInterface
    public void setSystemBars(String color, boolean dark) {
        if (!trusted() || !InputGuard.isColor(color)) return;
        activity.runOnUiThread(() -> activity.setSystemBars(color, dark));
    }

    @JavascriptInterface
    public String getAppInfo() {
        try {
            return new JSONObject()
                    .put("versionName", UpdateManager.currentVersionName(activity))
                    .put("versionCode", UpdateManager.currentVersionCode(activity))
                    .put("platform", "android")
                    .put("sdk", Build.VERSION.SDK_INT)
                    .toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /** Opens only allowlisted external links (see SafeUrl). */
    @JavascriptInterface
    public void openUrl(String url) {
        if (!trusted()) return;
        Uri u = SafeUrl.external(url);
        if (u == null) return;
        activity.runOnUiThread(() -> activity.openExternal(u));
    }

    @JavascriptInterface
    public void exitApp() {
        if (!trusted()) return;
        activity.runOnUiThread(() -> activity.moveTaskToBack(true));
    }

    // ------------------------------------------------------------------ local backup files

    @JavascriptInterface
    public String writeBackupFile(String name, String json) {
        if (!trusted()) return "{\"ok\":false}";
        try {
            if (!InputGuard.isBackupName(name)) return new JSONObject().put("ok", false).put("error", "Invalid backup name").toString();
            if (json == null || json.length() > InputGuard.MAX_BACKUP_CHARS || !json.trim().startsWith("{")) {
                return new JSONObject().put("ok", false).put("error", "Invalid backup data").toString();
            }
            File f = new File(FileStore.backupsDir(activity), name);
            FileStore.writeAtomically(f, json);
            return new JSONObject().put("ok", true).put("name", name).toString();
        } catch (IOException e) {
            return "{\"ok\":false,\"error\":\"Not enough storage or the file could not be written\"}";
        } catch (JSONException e) {
            return "{\"ok\":false}";
        }
    }

    @JavascriptInterface
    public String listBackupFiles() {
        if (!trusted()) return "[]";
        JSONArray out = new JSONArray();
        File[] files = FileStore.backupsDir(activity).listFiles();
        if (files != null) {
            Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File f : files) {
                if (!InputGuard.isBackupName(f.getName())) continue;
                try {
                    out.put(new JSONObject().put("name", f.getName()).put("size", f.length()).put("modified", f.lastModified()));
                } catch (JSONException ignored) {
                    // skip
                }
            }
        }
        return out.toString();
    }

    @JavascriptInterface
    public String readBackupFile(String name) {
        if (!trusted() || !InputGuard.isBackupName(name)) return null;
        File f = new File(FileStore.backupsDir(activity), name);
        if (!f.isFile() || f.length() > InputGuard.MAX_BACKUP_CHARS) return null;
        try {
            return FileStore.readText(f, InputGuard.MAX_BACKUP_CHARS);
        } catch (IOException e) {
            return null;
        }
    }

    @JavascriptInterface
    public String deleteBackupFile(String name) {
        if (!trusted() || !InputGuard.isBackupName(name)) return "false";
        File f = new File(FileStore.backupsDir(activity), name);
        return String.valueOf(f.isFile() && f.delete());
    }

    // ------------------------------------------------------------------ updates

    @JavascriptInterface
    public void checkUpdate(String cb, String url) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        io.execute(() -> {
            try {
                resolve(cb, UpdateManager.check(activity, url));
            } catch (UpdateManager.UpdateException e) {
                fail(cb, e.getMessage());
            } catch (RuntimeException e) {
                Log.w("update check crashed", e);
                fail(cb, "Could not check for updates");
            }
        });
    }

    @JavascriptInterface
    public void downloadAndInstallUpdate(String cb) {
        if (!trusted() || !InputGuard.isCallback(cb)) return;
        io.execute(() -> {
            try {
                String msg = UpdateManager.downloadVerifyAndInstall(activity, activity::reportUpdateProgress);
                resolve(cb, new JSONObject().put("ok", true).put("message", msg));
            } catch (UpdateManager.UpdateException e) {
                try {
                    resolve(cb, new JSONObject().put("ok", false).put("error", e.getMessage()).put("needsPermission", e.needsPermission));
                } catch (JSONException ignored) {
                    // cannot happen
                }
            } catch (JSONException | RuntimeException e) {
                Log.w("update failed", e);
                fail(cb, "The update could not be completed. Your data is unchanged.");
            }
        });
    }

    // ------------------------------------------------------------------ legacy data

    @JavascriptInterface
    public String getLegacyDataInfo() {
        return trusted() ? LegacyDataExporter.info(activity) : "{\"found\":false}";
    }

    @JavascriptInterface
    public String readLegacyData() {
        return trusted() ? LegacyDataExporter.read(activity) : null;
    }

    @JavascriptInterface
    public void markLegacyImported() {
        if (trusted()) LegacyDataExporter.markImported(activity);
    }
}
