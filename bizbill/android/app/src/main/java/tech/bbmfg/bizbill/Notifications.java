package tech.bbmfg.bizbill;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Local notifications. All content is generated on the device from the
 * user's own data; nothing goes through a push / notification server.
 */
final class Notifications {
    private Notifications() {}

    static final String EXTRA_ROUTE = "tech.bbmfg.bizbill.ROUTE";
    static final Set<String> TYPES = new HashSet<>(Arrays.asList("lowstock", "due", "overdue", "backup", "update", "system"));

    /** Channel family by alert type. */
    private static String family(String type) {
        switch (type) {
            case "due":
            case "overdue":
                return "payments";
            case "lowstock":
                return "stock";
            default:
                return "general";
        }
    }

    /**
     * Channels are created per sound/vibration combination because Android
     * 8+ fixes sound & vibration per channel.
     */
    static String channelId(String family, boolean sound, boolean vibration) {
        return family + "_" + (sound ? "s" : "") + (vibration ? "v" : "") + (!sound && !vibration ? "q" : "");
    }

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        String[][] fam = {
                {"payments", c.getString(R.string.channel_payments), c.getString(R.string.channel_payments_desc), "high"},
                {"stock", c.getString(R.string.channel_stock), c.getString(R.string.channel_stock_desc), "default"},
                {"general", c.getString(R.string.channel_general), c.getString(R.string.channel_general_desc), "low"},
                {"important", c.getString(R.string.channel_important), c.getString(R.string.channel_important_desc), "high"},
        };
        boolean[] opts = {true, false};
        for (String[] f : fam) {
            for (boolean s : opts) {
                for (boolean v : opts) {
                    String id = channelId(f[0], s, v);
                    int imp = "high".equals(f[3]) ? NotificationManager.IMPORTANCE_HIGH
                            : "low".equals(f[3]) ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_DEFAULT;
                    if (!s && imp > NotificationManager.IMPORTANCE_LOW) imp = NotificationManager.IMPORTANCE_DEFAULT;
                    String suffix = s && v ? "" : s ? " (no vibration)" : v ? " (silent)" : " (quiet)";
                    NotificationChannel ch = new NotificationChannel(id, f[1] + suffix, imp);
                    ch.setDescription(f[2]);
                    ch.enableVibration(v);
                    if (!s) ch.setSound(null, null);
                    ch.setShowBadge(true);
                    nm.createNotificationChannel(ch);
                }
            }
        }
    }

    static boolean enabled(Context c) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        return NotificationManagerCompat.from(c).areNotificationsEnabled();
    }

    static boolean fullScreenAllowed(Context c) {
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            return nm != null && nm.canUseFullScreenIntent();
        }
        return true;
    }

    /** Validated payload for a notification. */
    static final class Payload {
        int id;
        String type = "system";
        String title = "BizBill";
        String message = "";
        String route = "#/notifications";
        String[][] actions = new String[0][];
        boolean fullScreen;
        boolean sound = true;
        boolean vibration = true;

        static Payload parse(String json) throws JSONException {
            if (json == null || json.length() > InputGuard.MAX_JSON) throw new JSONException("too large");
            return from(new JSONObject(json));
        }

        static Payload from(JSONObject o) throws JSONException {
            Payload p = new Payload();
            p.id = Math.max(0, Math.min(1_000_000, o.optInt("id", 0)));
            String type = o.optString("type", "system");
            p.type = TYPES.contains(type) ? type : "system";
            p.title = InputGuard.text(o.optString("title", "BizBill"), 120);
            p.message = InputGuard.text(o.optString("message", ""), 1000);
            String route = o.optString("route", "#/notifications");
            p.route = InputGuard.isRoute(route) ? route : "#/notifications";
            JSONArray acts = o.optJSONArray("actions");
            int n = acts == null ? 0 : Math.min(3, acts.length());
            p.actions = new String[n][];
            int k = 0;
            for (int i = 0; i < n; i++) {
                JSONObject a = acts.optJSONObject(i);
                if (a == null) continue;
                String r = a.optString("route", "");
                if (!InputGuard.isRoute(r)) continue;
                p.actions[k++] = new String[]{InputGuard.text(a.optString("label", "Open"), 30), r};
            }
            p.actions = Arrays.copyOf(p.actions, k);
            p.fullScreen = o.optBoolean("fullScreen", false);
            p.sound = o.optBoolean("sound", true);
            p.vibration = o.optBoolean("vibration", true);
            return p;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id).put("type", type).put("title", title).put("message", message).put("route", route)
                    .put("fullScreen", fullScreen).put("sound", sound).put("vibration", vibration);
            JSONArray a = new JSONArray();
            for (String[] act : actions) a.put(new JSONObject().put("label", act[0]).put("route", act[1]));
            o.put("actions", a);
            return o;
        }
    }

    static PendingIntent openRoute(Context c, String route, int requestCode) {
        Intent i = new Intent(c, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .putExtra(EXTRA_ROUTE, route)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Post a notification. Returns false if notifications are disabled. */
    static boolean post(Context c, Payload p) {
        if (!enabled(c)) return false;
        ensureChannels(c);
        boolean important = p.fullScreen && ("due".equals(p.type) || "overdue".equals(p.type) || "lowstock".equals(p.type));
        boolean fullScreen = important && fullScreenAllowed(c);
        String ch = channelId(fullScreen ? "important" : family(p.type), p.sound, p.vibration);
        int base = (p.id * 8) & 0x0fffffff;
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, ch)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(c, R.color.brand))
                .setContentTitle(p.title)
                .setContentText(firstLine(p.message))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(p.message))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setCategory("due".equals(p.type) || "overdue".equals(p.type) ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_STATUS)
                .setPriority("due".equals(p.type) || "overdue".equals(p.type) || important ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openRoute(c, p.route, base));
        if (!p.sound && !p.vibration) b.setSilent(true);
        // Public version on the lock screen hides amounts and names.
        b.setPublicVersion(new NotificationCompat.Builder(c, ch)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(p.title)
                .setContentText("Open BizBill to see details")
                .build());
        int k = 1;
        for (String[] a : p.actions) b.addAction(0, a[0], openRoute(c, a[1], base + k++));
        if ("due".equals(p.type) || "overdue".equals(p.type)) {
            b.addAction(0, c.getString(R.string.snooze), ReminderReceiver.snoozeIntent(c, p, base + 5));
        }
        if (fullScreen) {
            Intent full = AlertActivity.intent(c, p);
            b.setFullScreenIntent(PendingIntent.getActivity(c, base + 6, full, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE), true);
        }
        try {
            NotificationManagerCompat.from(c).notify(p.type, p.id, b.build());
            return true;
        } catch (SecurityException e) {
            Log.w("notify denied", e);
            return false;
        }
    }

    static void cancel(Context c, String type, int id) {
        NotificationManagerCompat.from(c).cancel(type, id);
    }

    private static String firstLine(String s) {
        int i = s.indexOf('\n');
        return i >= 0 ? s.substring(0, i) : s;
    }
}
