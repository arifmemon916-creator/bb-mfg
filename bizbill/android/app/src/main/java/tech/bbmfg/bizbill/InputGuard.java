package tech.bbmfg.bizbill;

import android.util.Base64;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validation for every value that crosses the JavaScript bridge.
 * Anything that does not match is rejected; nothing is "fixed up" silently
 * except file names, which are sanitised to a safe character set.
 */
final class InputGuard {
    private InputGuard() {}

    /** Largest document accepted from the web layer (decoded bytes). */
    static final int MAX_FILE_BYTES = 30 * 1024 * 1024;
    /** Largest backup JSON kept by the app. */
    static final int MAX_BACKUP_CHARS = 60 * 1024 * 1024;
    static final int MAX_TEXT = 4000;
    static final int MAX_JSON = 512 * 1024;

    private static final Pattern CALLBACK = Pattern.compile("^cb[0-9]{1,9}$");
    private static final Pattern ROUTE = Pattern.compile("^#/[A-Za-z0-9/_?=&.%-]{0,200}$");
    private static final Pattern COLOR = Pattern.compile("^#[0-9a-fA-F]{6}$");
    private static final Pattern BACKUP_NAME = Pattern.compile("^[A-Za-z0-9._-]{1,120}\\.json$");
    private static final Pattern EMAIL = Pattern.compile("^[^\\s@<>]{1,64}@[^\\s@<>]{1,190}\\.[A-Za-z]{2,24}$");
    private static final Pattern B64 = Pattern.compile("^[A-Za-z0-9+/]*={0,2}$");

    static final Set<String> SHARE_MIME = new HashSet<>(Arrays.asList(
            "application/pdf", "image/jpeg", "image/png", "image/webp", "application/json", "text/csv", "text/plain"));

    static boolean isCallback(String id) {
        return id != null && CALLBACK.matcher(id).matches();
    }

    static boolean isRoute(String r) {
        return r != null && ROUTE.matcher(r).matches() && !r.contains("..");
    }

    static boolean isColor(String c) {
        return c != null && COLOR.matcher(c).matches();
    }

    static boolean isBackupName(String n) {
        return n != null && BACKUP_NAME.matcher(n).matches() && !n.startsWith(".");
    }

    static boolean isEmail(String e) {
        return e != null && EMAIL.matcher(e).matches();
    }

    static String mime(String m) {
        if (m == null) return null;
        String v = m.trim().toLowerCase(Locale.ROOT);
        return SHARE_MIME.contains(v) ? v : null;
    }

    /** Clamp free text (share messages, notification text). */
    static String text(String s, int max) {
        if (s == null) return "";
        String t = s.replace('\u0000', ' ');
        return t.length() > max ? t.substring(0, max) : t;
    }

    /**
     * Sanitise a file name: letters, digits, space, dot, dash, underscore,
     * brackets only; no path separators, no leading dots, bounded length,
     * extension forced to match the MIME type.
     */
    static String fileName(String name, String mime) {
        String base = name == null ? "" : name;
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9 ._()\\-]", "_").replaceAll("^[.\\s]+", "").trim();
        String ext = extensionFor(mime);
        String lower = base.toLowerCase(Locale.ROOT);
        if (ext != null && lower.endsWith(ext)) base = base.substring(0, base.length() - ext.length());
        base = base.replaceAll("\\.+$", "");
        if (base.isEmpty()) base = "BizBill";
        if (base.length() > 80) base = base.substring(0, 80);
        return ext == null ? base : base + ext;
    }

    static String extensionFor(String mime) {
        if (mime == null) return null;
        switch (mime) {
            case "application/pdf": return ".pdf";
            case "image/jpeg": return ".jpg";
            case "image/png": return ".png";
            case "image/webp": return ".webp";
            case "application/json": return ".json";
            case "text/csv": return ".csv";
            case "text/plain": return ".txt";
            default: return null;
        }
    }

    /** Decode base64 after checking alphabet and size. Returns null when invalid. */
    static byte[] base64(String b64, int maxBytes) {
        if (b64 == null) return null;
        String s = b64.trim();
        if (s.isEmpty() || s.length() % 4 != 0) return null;
        if ((long) s.length() / 4 * 3 > maxBytes + 3L) return null;
        if (!B64.matcher(s).matches()) return null;
        try {
            byte[] out = Base64.decode(s, Base64.NO_WRAP);
            return out.length <= maxBytes ? out : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Check that decoded bytes really are the declared type (magic numbers). */
    static boolean contentMatches(byte[] b, String mime) {
        if (b == null || b.length < 4) return false;
        switch (mime) {
            case "application/pdf":
                return b[0] == '%' && b[1] == 'P' && b[2] == 'D' && b[3] == 'F';
            case "image/jpeg":
                return (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff;
            case "image/png":
                return (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G';
            case "image/webp":
                return b.length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P';
            case "application/json":
            case "text/csv":
            case "text/plain":
                // Text: reject binary (NUL bytes) in the first KB.
                for (int i = 0; i < Math.min(b.length, 1024); i++) if (b[i] == 0) return false;
                return true;
            default:
                return false;
        }
    }

    /** Digits of a phone number suitable for WhatsApp (adds India code to 10-digit numbers). */
    static String whatsappNumber(String phone) {
        if (phone == null) return null;
        String d = phone.replaceAll("[^0-9]", "");
        if (d.length() == 10) d = "91" + d;
        return d.length() >= 11 && d.length() <= 15 ? d : null;
    }
}
