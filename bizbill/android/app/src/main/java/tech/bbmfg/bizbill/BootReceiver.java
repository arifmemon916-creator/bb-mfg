package tech.bbmfg.bizbill;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarms are cleared on reboot and on app update; restore the reminder schedule. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            ReminderScheduler.armAll(context);
        }
    }
}
