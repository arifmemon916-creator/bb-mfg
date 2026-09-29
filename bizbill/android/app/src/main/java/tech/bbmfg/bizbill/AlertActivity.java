package tech.bbmfg.bizbill;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

import org.json.JSONException;

/**
 * Full-screen alert shown through Android's official full-screen
 * notification intent (only when the user enabled it and Android allows it).
 * It may appear over the lock screen, but opening BizBill still requires the
 * user to unlock the device: the keyguard is never bypassed.
 */
public class AlertActivity extends Activity {
    private static final String EXTRA = "tech.bbmfg.bizbill.ALERT";
    private Notifications.Payload payload;

    static Intent intent(Context c, Notifications.Payload p) {
        Intent i = new Intent(c, AlertActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        try {
            i.putExtra(EXTRA, p.toJson().toString());
        } catch (JSONException ignored) {
            // always serialisable
        }
        return i;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            payload = Notifications.Payload.parse(getIntent().getStringExtra(EXTRA));
        } catch (JSONException | RuntimeException e) {
            finish();
            return;
        }
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        setContentView(buildView());
    }

    private LinearLayout buildView() {
        int pad = dp(24);
        int fg = ContextCompat.getColor(this, R.color.alert_text);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(payload.title.toUpperCase(java.util.Locale.ROOT));
        title.setTextColor(fg);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        ScrollView sv = new ScrollView(this);
        TextView msg = new TextView(this);
        msg.setText(payload.message);
        msg.setTextColor(fg);
        msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        msg.setGravity(Gravity.CENTER);
        msg.setPadding(0, dp(16), 0, dp(24));
        sv.addView(msg);
        root.addView(sv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        for (String[] a : payload.actions) root.addView(button(a[0], () -> open(a[1])));
        if (payload.actions.length == 0) root.addView(button(getString(R.string.view_details), () -> open(payload.route)));
        if ("due".equals(payload.type) || "overdue".equals(payload.type)) {
            root.addView(button(getString(R.string.snooze), () -> {
                ReminderReceiver.snooze(this, payload);
                finish();
            }));
        }
        root.addView(button(getString(R.string.dismiss), () -> {
            Notifications.cancel(this, payload.type, payload.id);
            finish();
        }));
        return root;
    }

    private Button button(String label, Runnable r) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        b.setOnClickListener(v -> r.run());
        return b;
    }

    /** Opens the related screen; Android asks the user to unlock first. */
    private void open(String route) {
        Notifications.cancel(this, payload.type, payload.id);
        Intent i = new Intent(this, MainActivity.class).setAction(Intent.ACTION_VIEW)
                .putExtra(Notifications.EXTRA_ROUTE, route).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && km != null && km.isKeyguardLocked()) {
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    startActivity(i);
                    finish();
                }
            });
        } else {
            startActivity(i);
            finish();
        }
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
