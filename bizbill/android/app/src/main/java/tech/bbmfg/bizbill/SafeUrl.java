package tech.bbmfg.bizbill;

import android.net.Uri;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Allowlist for anything that leaves the app.
 *  - App content: only https://appassets.androidplatform.net/assets/www/...
 *  - External links: https to a small set of hosts, tel:, mailto:, upi:.
 *  - Everything else (javascript:, file:, content:, intent:, data:, http:,
 *    unknown schemes and hosts) is blocked.
 */
final class SafeUrl {
    private SafeUrl() {}

    static final String APP_HOST = "appassets.androidplatform.net";
    static final String APP_PREFIX = "/assets/www/";
    static final String START_URL = "https://" + APP_HOST + APP_PREFIX + "index.html";

    private static final Set<String> EXTERNAL_HOSTS = new HashSet<>(Arrays.asList(
            "wa.me", "api.whatsapp.com", "github.com", "www.gst.gov.in", "services.gst.gov.in"));

    static boolean isAppUrl(Uri u) {
        return u != null && "https".equals(u.getScheme()) && APP_HOST.equals(u.getHost())
                && u.getPort() == -1 && u.getUserInfo() == null
                && u.getPath() != null && u.getPath().startsWith(APP_PREFIX) && !u.getPath().contains("..");
    }

    /** Returns a sanitised Uri that may be opened externally, or null. */
    static Uri external(String url) {
        if (url == null || url.length() > 2000) return null;
        Uri u;
        try {
            u = Uri.parse(url.trim());
        } catch (Exception e) {
            return null;
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "https": {
                String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
                if (u.getUserInfo() != null || (u.getPort() != -1 && u.getPort() != 443)) return null;
                return EXTERNAL_HOSTS.contains(host) ? u : null;
            }
            case "tel": {
                String n = u.getSchemeSpecificPart();
                return n != null && n.matches("^\\+?[0-9 ()-]{3,20}$") ? u : null;
            }
            case "mailto": {
                String addr = u.getSchemeSpecificPart();
                if (addr == null) return null;
                int q = addr.indexOf('?');
                String a = q >= 0 ? addr.substring(0, q) : addr;
                return a.isEmpty() || InputGuard.isEmail(a) ? u : null;
            }
            case "upi":
                return "pay".equals(u.getHost()) ? u : null;
            default:
                return null;
        }
    }
}
