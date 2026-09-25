package tech.bbmfg.bizbill;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/** Receives PackageInstaller status: shows Android's confirmation screen, reports failures. */
public class InstallResultReceiver extends BroadcastReceiver {
    static final String ACTION = "tech.bbmfg.bizbill.action.INSTALL_RESULT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : legacyExtra(intent);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                // The confirmation activity belongs to the system package installer.
                context.startActivity(confirm);
            }
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            Notifications.Payload p = new Notifications.Payload();
            p.id = 7;
            p.type = "update";
            p.title = context.getString(R.string.update_failed);
            p.message = status == PackageInstaller.STATUS_FAILURE_ABORTED
                    ? "The update was cancelled. You can try again from the Update Center."
                    : "Android could not install the update. Your data is unchanged. Try again from the Update Center.";
            p.route = "#/update";
            Notifications.post(context, p);
        }
    }

    @SuppressWarnings("deprecation")
    private static Intent legacyExtra(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_INTENT);
    }
}
