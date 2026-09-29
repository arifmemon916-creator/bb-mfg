package tech.bbmfg.bizbill;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

/**
 * Stores the reminder schedule computed by the app (payment due, overdue,
 * backup) and arms AlarmManager for each entry. The whole schedule is
 * replaced every time the app recalculates, so paid invoices lose their
 * reminders and partial payments update the amount shown.
 *
 * Uses inexact, battery-friendly alarms (no exact-alarm permission needed).
 */
final class ReminderScheduler {
    private ReminderScheduler() {}

    private static final String PREFS = "reminders";
    private static final String KEY_ALL = "schedule";
    static final String EXTRA_KEY = "tech.bbmfg.bizbill.REMINDER_KEY";
    private static final int MAX_ITEMS = 200;

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** items: JSON array of {key, at, ...notification payload}. Invalid entries are dropped. */
    static synchronized int replaceAll(Context c, String json) throws JSONException {
        if (json == null || json.length() > InputGuard.MAX_JSON) throw new JSONException("too large");
        JSONArray in = new JSONArray(json);
        JSONObject stored = load(c);
        // Cancel alarms that are no longer wanted.
        for (Iterator<String> it = stored.keys(); it.hasNext(); ) {
            String k = it.next();
            if (!k.startsWith("snooze|") && !k.startsWith("backup")) cancelAlarm(c, k);
        }
        JSONObject next = new JSONObject();
        // Keep snoozes and the backup reminder (managed separately).
        for (Iterator<String> it = stored.keys(); it.hasNext(); ) {
            String k = it.next();
            if (k.startsWith("snooze|") || k.startsWith("backup")) next.put(k, stored.get(k));
        }
        long now = System.currentTimeMillis();
        int count = 0;
        for (int i = 0; i < in.length() && count < MAX_ITEMS; i++) {
            JSONObject o = in.optJSONObject(i);
            if (o == null) continue;
            String key = o.optString("key", "");
            long at = o.optLong("at", 0);
            if (key.isEmpty() || key.length() > 120 || at <= now || at > now + 400L * 86400000L) continue;
            Notifications.Payload p = Notifications.Payload.from(o);
            p.id = 2000 + (key.hashCode() & 0x7ffff);
            JSONObject entry = p.toJson().put("at", at);
            next.put("r|" + key, entry);
            count++;
        }
        save(c, next);
        armAll(c);
        return count;
    }

    static synchronized void setSingle(Context c, String key, long at, Notifications.Payload p) throws JSONException {
        JSONObject all = load(c);
        cancelAlarm(c, key);
        all.put(key, p.toJson().put("at", at));
        save(c, all);
        arm(c, key, at);
    }

    static synchronized void remove(Context c, String key) {
        JSONObject all = load(c);
        cancelAlarm(c, key);
        all.remove(key);
        save(c, all);
    }

    /** Called from the alarm: returns the payload and forgets it. */
    static synchronized Notifications.Payload take(Context c, String key) {
        JSONObject all = load(c);
        JSONObject o = all.optJSONObject(key);
        if (o == null) return null;
        all.remove(key);
        save(c, all);
        try {
            return Notifications.Payload.from(o);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Re-arm everything (after reboot / app update). Past entries fire now. */
    static synchronized void armAll(Context c) {
        JSONObject all = load(c);
        long now = System.currentTimeMillis();
        for (Iterator<String> it = all.keys(); it.hasNext(); ) {
            String k = it.next();
            JSONObject o = all.optJSONObject(k);
            if (o == null) continue;
            arm(c, k, Math.max(o.optLong("at", now), now + 5000));
        }
    }

    private static PendingIntent pending(Context c, String key, int flags) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction(ReminderReceiver.ACTION_FIRE).putExtra(EXTRA_KEY, key);
        return PendingIntent.getBroadcast(c, key.hashCode(), i, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void arm(Context c, String key, long at) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(c, key, PendingIntent.FLAG_UPDATE_CURRENT));
    }

    private static void cancelAlarm(Context c, String key) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = pending(c, key, PendingIntent.FLAG_NO_CREATE);
        if (am != null && pi != null) {
            am.cancel(pi);
            pi.cancel();
        }
    }

    private static JSONObject load(Context c) {
        try {
            return new JSONObject(prefs(c).getString(KEY_ALL, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static void save(Context c, JSONObject all) {
        prefs(c).edit().putString(KEY_ALL, all.toString()).apply();
    }
}
