package tech.bbmfg.bizbill;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONException;

/** Fires scheduled reminders and handles "Snooze" from notifications / alerts. */
public class ReminderReceiver extends BroadcastReceiver {
    static final String ACTION_FIRE = "tech.bbmfg.bizbill.action.FIRE_REMINDER";
    static final String ACTION_SNOOZE = "tech.bbmfg.bizbill.action.SNOOZE";
    static final String EXTRA_PAYLOAD = "tech.bbmfg.bizbill.PAYLOAD";
    static final long SNOOZE_MS = 60L * 60L * 1000L;

    static PendingIntent snoozeIntent(Context c, Notifications.Payload p, int requestCode) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction(ACTION_SNOOZE);
        try {
            i.putExtra(EXTRA_PAYLOAD, p.toJson().toString());
        } catch (JSONException ignored) {
            // payload is always serialisable
        }
        return PendingIntent.getBroadcast(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void snooze(Context c, Notifications.Payload p) {
        try {
            ReminderScheduler.setSingle(c, "snooze|" + p.type + "|" + p.id, System.currentTimeMillis() + SNOOZE_MS, p);
        } catch (JSONException e) {
            Log.w("snooze failed", e);
        }
        Notifications.cancel(c, p.type, p.id);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        if (ACTION_FIRE.equals(intent.getAction())) {
            String key = intent.getStringExtra(ReminderScheduler.EXTRA_KEY);
            if (key == null) return;
            Notifications.Payload p = ReminderScheduler.take(context, key);
            if (p != null) Notifications.post(context, p);
        } else if (ACTION_SNOOZE.equals(intent.getAction())) {
            String json = intent.getStringExtra(EXTRA_PAYLOAD);
            try {
                snooze(context, Notifications.Payload.parse(json));
            } catch (JSONException e) {
                Log.w("bad snooze payload", e);
            }
        }
    }
}
