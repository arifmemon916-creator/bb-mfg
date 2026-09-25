package tech.bbmfg.bizbill;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;

/**
 * Secure in-app update.
 *
 * update.json is accepted only if:
 *   - it is downloaded over HTTPS from an allowlisted host (every redirect is re-checked),
 *   - packageName equals this app's package,
 *   - latestVersionCode is an integer, sha256 is 64 hex chars,
 *   - downloadUrl is HTTPS on an allowlisted host.
 *
 * The downloaded APK is installed only if ALL of these hold:
 *   1. complete download within the size limit,
 *   2. SHA-256 equals update.json's sha256,
 *   3. APK package name equals this app,
 *   4. APK versionCode equals latestVersionCode and is higher than the installed one,
 *   5. APK signing certificate equals the installed app's certificate
 *      (key rotation is accepted only through the APK's signed lineage).
 * Installation then uses the official PackageInstaller API; Android shows its
 * own confirmation screen and re-verifies the signature. There is no bypass.
 */
final class UpdateManager {
    private UpdateManager() {}

    private static final int MAX_META_BYTES = 64 * 1024;
    private static final long MAX_APK_BYTES = 150L * 1024 * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final Pattern SHA = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern VERSION = Pattern.compile("^[0-9]+(\\.[0-9]+){0,3}$");
    private static final Set<String> HOSTS = new HashSet<>(Arrays.asList(BuildConfig.UPDATE_HOSTS.split(",")));

    /** Last validated metadata (only this can be downloaded). */
    private static volatile Meta pending;

    static final class Meta {
        String versionName;
        int versionCode;
        String downloadUrl;
        String sha256;
        String notes;
        boolean mandatory;
    }

    interface Progress {
        void onProgress(int percent);
    }

    static final class UpdateException extends Exception {
        private static final long serialVersionUID = 1L;
        final boolean needsPermission;

        UpdateException(String msg) {
            this(msg, false);
        }

        UpdateException(String msg, boolean needsPermission) {
            super(msg);
            this.needsPermission = needsPermission;
        }
    }

    // ------------------------------------------------------------ metadata

    static JSONObject check(Context c, String url) throws UpdateException {
        requireOnline(c);
        byte[] body = download(url, MAX_META_BYTES);
        JSONObject o;
        try {
            o = new JSONObject(new String(body, java.nio.charset.StandardCharsets.UTF_8));
        } catch (JSONException e) {
            throw new UpdateException("Update information is not valid");
        }
        Meta m = validateMetadata(c.getPackageName(), currentVersionName(c), o);
        int currentCode = currentVersionCode(c);
        String currentName = currentVersionName(c);
        boolean available = m.versionCode > currentCode;
        pending = available ? m : null;
        try {
            return new JSONObject()
                    .put("ok", true)
                    .put("available", available)
                    .put("mandatory", available && m.mandatory)
                    .put("latestVersionName", m.versionName)
                    .put("latestVersionCode", m.versionCode)
                    .put("currentVersionName", currentName)
                    .put("currentVersionCode", currentCode)
                    .put("releaseNotes", m.notes);
        } catch (JSONException e) {
            throw new UpdateException("Internal error");
        }
    }

    static Meta validateMetadata(String packageName, String currentVersionName, JSONObject o) throws UpdateException {
        if (!packageName.equals(o.optString("packageName"))) throw new UpdateException("Update is for a different app (package name mismatch)");
        Object code = o.opt("latestVersionCode");
        if (!(code instanceof Integer) || (Integer) code <= 0) throw new UpdateException("Update version code is invalid");
        String name = o.optString("latestVersionName", "");
        if (!VERSION.matcher(name).matches()) throw new UpdateException("Update version name is invalid");
        String sha = o.optString("sha256", "").toLowerCase(Locale.ROOT);
        if (!SHA.matcher(sha).matches()) throw new UpdateException("Update checksum is missing or invalid");
        String dl = o.optString("downloadUrl", "");
        if (!hostAllowed(dl)) throw new UpdateException("Update download address is not trusted");
        String min = o.optString("minimumSupportedVersion", "");
        if (!min.isEmpty() && !VERSION.matcher(min).matches()) throw new UpdateException("Minimum supported version is invalid");
        Meta m = new Meta();
        m.versionCode = (Integer) code;
        m.versionName = name;
        m.sha256 = sha;
        m.downloadUrl = dl;
        m.notes = InputGuard.text(o.optString("releaseNotes", ""), 4000);
        boolean belowMin = !min.isEmpty() && compareVersions(currentVersionName, min) < 0;
        m.mandatory = o.optBoolean("mandatoryUpdate", false) || belowMin;
        return m;
    }

    // ------------------------------------------------------------ download + verify + install

    static String downloadVerifyAndInstall(Context c, Progress progress) throws UpdateException {
        Meta m = pending;
        if (m == null) throw new UpdateException("Check for updates first");
        if (m.versionCode <= currentVersionCode(c)) throw new UpdateException("This version is already installed");
        if (Build.VERSION.SDK_INT >= 26 && !c.getPackageManager().canRequestPackageInstalls()) {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            throw new UpdateException("Android needs your permission to install the update.", true);
        }
        requireOnline(c);
        File dir = FileStore.updatesDir(c);
        StatFs fs = new StatFs(dir.getAbsolutePath());
        if (fs.getAvailableBytes() < 2 * MAX_APK_BYTES / 3) throw new UpdateException("Not enough free storage to download the update");
        File part = new File(dir, "update.apk.part");
        File apk = new File(dir, "update.apk");
        //noinspection ResultOfMethodCallIgnored
        part.delete();
        //noinspection ResultOfMethodCallIgnored
        apk.delete();
        try {
            byte[] digest = downloadToFile(m.downloadUrl, part, progress);
            if (!MessageDigest.isEqual(digest, hex(m.sha256))) throw new UpdateException("Update rejected: checksum does not match (file corrupted or modified)");
            if (!part.renameTo(apk)) throw new UpdateException("Could not prepare the update file");
            verifyApk(c, apk, m.versionCode);
            install(c, apk);
            return "Update verified. Follow the Android installer to finish. Your data is kept.";
        } catch (UpdateException e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
            throw e;
        }
    }

    @SuppressLint("PackageManagerGetSignatures")
    static void verifyApk(Context c, File apk, int expectedCode) throws UpdateException {
        PackageManager pm = c.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (archive == null) throw new UpdateException("Update rejected: the file is not a valid Android app");
        if (!c.getPackageName().equals(archive.packageName)) throw new UpdateException("Update rejected: package name does not match");
        long code = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
        if (code != expectedCode) throw new UpdateException("Update rejected: version does not match the release information");
        if (code <= currentVersionCode(c)) throw new UpdateException("Update rejected: version is not newer than the installed app");
        PackageInfo installed;
        try {
            installed = pm.getPackageInfo(c.getPackageName(), flags);
        } catch (PackageManager.NameNotFoundException e) {
            throw new UpdateException("Internal error");
        }
        if (!sameSigner(archive, installed)) throw new UpdateException("Update rejected: it is not signed by the BizBill publisher");
    }

    @SuppressWarnings("deprecation")
    private static boolean sameSigner(PackageInfo archive, PackageInfo installed) {
        if (Build.VERSION.SDK_INT >= 28) {
            SigningInfo a = archive.signingInfo;
            SigningInfo i = installed.signingInfo;
            if (a == null || i == null) return false;
            Set<String> installedCurrent = digests(i.getApkContentsSigners());
            Set<String> archiveCurrent = digests(a.getApkContentsSigners());
            if (installedCurrent.isEmpty()) return false;
            if (archiveCurrent.equals(installedCurrent)) return true;
            // Key rotation (APK Signature Scheme v3): the new APK's signed lineage
            // must include the key the installed app is signed with.
            return !a.hasMultipleSigners() && digests(a.getSigningCertificateHistory()).containsAll(installedCurrent);
        }
        Signature[] a = archive.signatures;
        Signature[] i = installed.signatures;
        return a != null && i != null && a.length > 0 && digests(a).equals(digests(i));
    }

    private static Set<String> digests(Signature[] sigs) {
        Set<String> out = new HashSet<>();
        if (sigs == null) return out;
        for (Signature s : sigs) {
            try {
                byte[] d = MessageDigest.getInstance("SHA-256").digest(s.toByteArray());
                StringBuilder sb = new StringBuilder();
                for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b));
                out.add(sb.toString());
            } catch (NoSuchAlgorithmException ignored) {
                // SHA-256 is always available
            }
        }
        return out;
    }

    private static void install(Context c, File apk) throws UpdateException {
        PackageInstaller installer = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        int sessionId;
        try {
            sessionId = installer.createSession(params);
        } catch (IOException e) {
            throw new UpdateException("Android could not start the installer");
        }
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("bizbill.apk", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                session.fsync(out);
            }
            Intent result = new Intent(c, InstallResultReceiver.class).setAction(InstallResultReceiver.ACTION);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pi = PendingIntent.getBroadcast(c, sessionId, result, flags);
            session.commit(pi.getIntentSender());
        } catch (IOException | RuntimeException e) {
            installer.abandonSession(sessionId);
            throw new UpdateException("Could not hand the update to Android's installer");
        } finally {
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
        }
    }

    // ------------------------------------------------------------ helpers

    static boolean hostAllowed(String url) {
        try {
            Uri u = Uri.parse(url);
            return "https".equals(u.getScheme()) && u.getHost() != null && HOSTS.contains(u.getHost().toLowerCase(Locale.ROOT))
                    && u.getUserInfo() == null && (u.getPort() == -1 || u.getPort() == 443);
        } catch (Exception e) {
            return false;
        }
    }

    private static void requireOnline(Context c) throws UpdateException {
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
        if (nc == null || !nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) throw new UpdateException("No internet connection");
    }

    /** Opens an HTTPS connection following redirects only to allowlisted hosts. */
    private static HttpURLConnection open(String url) throws UpdateException, IOException {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!hostAllowed(current)) throw new UpdateException("Update address is not trusted");
            HttpURLConnection conn = (HttpURLConnection) URI.create(current).toURL().openConnection();
            if (!(conn instanceof HttpsURLConnection)) throw new UpdateException("Update address must use HTTPS");
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Accept", "application/json, application/octet-stream, */*");
            conn.setRequestProperty("User-Agent", "BizBill-Updater");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null) throw new UpdateException("Update server sent an invalid redirect");
                current = URI.create(current).resolve(loc).toString();
                continue;
            }
            if (code == 404) throw new UpdateException("No published release found");
            if (code != 200) throw new UpdateException("Update server returned " + code);
            return conn;
        }
        throw new UpdateException("Too many redirects");
    }

    private static byte[] download(String url, int max) throws UpdateException {
        try {
            HttpURLConnection conn = open(url);
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (out.size() + n > max) throw new UpdateException("Update information is too large");
                    out.write(buf, 0, n);
                }
                return out.toByteArray();
            } finally {
                conn.disconnect();
            }
        } catch (IOException e) {
            throw new UpdateException("Could not reach the update server");
        }
    }

    private static byte[] downloadToFile(String url, File dest, Progress p) throws UpdateException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new UpdateException("Internal error");
        }
        try {
            HttpURLConnection conn = open(url);
            long total = conn.getContentLengthLong();
            if (total > MAX_APK_BYTES) throw new UpdateException("Update file is too large");
            long done = 0;
            int lastPct = -1;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    done += n;
                    if (done > MAX_APK_BYTES) throw new UpdateException("Update file is too large");
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                    if (p != null && total > 0) {
                        int pct = (int) (done * 100 / total);
                        if (pct != lastPct && pct % 2 == 0) {
                            lastPct = pct;
                            p.onProgress(Math.min(99, pct));
                        }
                    }
                }
            } finally {
                conn.disconnect();
            }
            if (total > 0 && done != total) throw new UpdateException("Download was interrupted. Please try again.");
            if (p != null) p.onProgress(100);
            return md.digest();
        } catch (IOException e) {
            throw new UpdateException("Download failed. Check your internet connection and try again.");
        }
    }

    private static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    static int compareVersions(String a, String b) {
        String[] pa = a.split("[.-]");
        String[] pb = b.split("[.-]");
        for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
            int x = i < pa.length ? parse(pa[i]) : 0;
            int y = i < pb.length ? parse(pb[i]) : 0;
            if (x != y) return x > y ? 1 : -1;
        }
        return 0;
    }

    private static int parse(String s) {
        try {
            return Integer.parseInt(s.replaceAll("[^0-9]", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    static int currentVersionCode(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return BuildConfig.VERSION_CODE;
        }
    }

    static String currentVersionName(Context c) {
        return BuildConfig.VERSION_NAME.replace("-debug", "");
    }
}
