package tech.bbmfg.bizbill;

import android.app.Application;

import java.io.File;

public class BizBillApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Notifications.ensureChannels(this);
        // Remove temporary share / camera / print / update files left from
        // earlier sessions (older than 1 hour).
        FileStore.cleanTemp(this, 60 * 60 * 1000L);
        new File(getCacheDir(), "updates").mkdirs();
    }
}
