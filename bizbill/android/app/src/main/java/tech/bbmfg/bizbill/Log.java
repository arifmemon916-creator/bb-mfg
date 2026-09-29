package tech.bbmfg.bizbill;

/** Logging that is compiled out of release builds (and stripped by R8). */
final class Log {
    private Log() {}
    private static final String TAG = "BizBill";

    static void d(String msg) {
        if (BuildConfig.DEBUG) android.util.Log.d(TAG, msg);
    }

    /** Warnings never include user data; only the exception type in release. */
    static void w(String msg, Throwable t) {
        if (BuildConfig.DEBUG) android.util.Log.w(TAG, msg, t);
        else android.util.Log.w(TAG, msg + (t != null ? " (" + t.getClass().getSimpleName() + ")" : ""));
    }
}
