package tech.bbmfg.bizbill;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.net.Uri;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;

/** Tests for the bridge input validation, URL allowlist and update metadata rules. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class SecurityTest {

    @Test
    public void fileNamesAreSanitised() {
        assertEquals("passwd.pdf", InputGuard.fileName("../../etc/passwd", "application/pdf"));
        assertEquals("INV-1.pdf", InputGuard.fileName("Invoice/INV-1", "application/pdf")); // path separators never survive
        assertEquals("BizBill.jpg", InputGuard.fileName("....", "image/jpeg"));
        assertEquals("a_b_c.csv", InputGuard.fileName("a<b>c.csv", "text/csv"));
        assertEquals("report.pdf", InputGuard.fileName("report.pdf", "application/pdf"));
        assertEquals("x.exe.pdf", InputGuard.fileName("x.exe", "application/pdf"));
        assertTrue(InputGuard.fileName(new String(new char[300]).replace('\0', 'a'), "application/pdf").length() <= 84);
    }

    @Test
    public void mimeAllowlist() {
        assertEquals("application/pdf", InputGuard.mime("APPLICATION/PDF"));
        assertNull(InputGuard.mime("application/vnd.android.package-archive"));
        assertNull(InputGuard.mime("text/html"));
        assertNull(InputGuard.mime(null));
    }

    @Test
    public void base64IsValidatedBeforeDecoding() {
        assertNull(InputGuard.base64("@@@@", 100));
        assertNull(InputGuard.base64("abc", 100)); // bad length
        assertNull(InputGuard.base64("", 100));
        assertNull(InputGuard.base64(null, 100));
        assertNull(InputGuard.base64("QUJDREVGR0g=", 3)); // too large
        assertArrayEquals("ABC".getBytes(StandardCharsets.US_ASCII), InputGuard.base64("QUJD", 100));
    }

    @Test
    public void contentMustMatchDeclaredType() {
        assertTrue(InputGuard.contentMatches("%PDF-1.7".getBytes(StandardCharsets.US_ASCII), "application/pdf"));
        assertFalse(InputGuard.contentMatches("<html>".getBytes(StandardCharsets.US_ASCII), "application/pdf"));
        assertTrue(InputGuard.contentMatches(new byte[]{(byte) 0xff, (byte) 0xd8, (byte) 0xff, 0}, "image/jpeg"));
        assertFalse(InputGuard.contentMatches(new byte[]{'a', 0, 'b', 'c'}, "text/csv"));
    }

    @Test
    public void routesCallbacksColours() {
        assertTrue(InputGuard.isRoute("#/doc/abc123"));
        assertTrue(InputGuard.isRoute("#/payment/new/in?party=p1&doc=d2"));
        assertFalse(InputGuard.isRoute("javascript:alert(1)"));
        assertFalse(InputGuard.isRoute("#/../../x"));
        assertFalse(InputGuard.isRoute("#/doc/<script>"));
        assertTrue(InputGuard.isCallback("cb12"));
        assertFalse(InputGuard.isCallback("cb1');alert(1);//"));
        assertTrue(InputGuard.isColor("#1f4e79"));
        assertFalse(InputGuard.isColor("red;"));
        assertTrue(InputGuard.isBackupName("auto-Shop-backup-20260925-1030.json"));
        assertFalse(InputGuard.isBackupName("../x.json"));
        assertFalse(InputGuard.isBackupName("x.sh"));
        assertEquals("919876543210", InputGuard.whatsappNumber("+91 98765 43210"));
        assertEquals("919876543210", InputGuard.whatsappNumber("9876543210"));
        assertNull(InputGuard.whatsappNumber("12"));
    }

    @Test
    public void onlyAppAssetsAreTrusted() {
        assertTrue(SafeUrl.isAppUrl(Uri.parse("https://appassets.androidplatform.net/assets/www/index.html")));
        assertFalse(SafeUrl.isAppUrl(Uri.parse("http://appassets.androidplatform.net/assets/www/index.html")));
        assertFalse(SafeUrl.isAppUrl(Uri.parse("https://appassets.androidplatform.net/res/x")));
        assertFalse(SafeUrl.isAppUrl(Uri.parse("https://appassets.androidplatform.net/assets/www/../../x")));
        assertFalse(SafeUrl.isAppUrl(Uri.parse("https://evil.com/assets/www/index.html")));
        assertFalse(SafeUrl.isAppUrl(Uri.parse("file:///android_asset/www/index.html")));
    }

    @Test
    public void dangerousExternalUrlsAreBlocked() {
        String[] blocked = {
                "javascript:alert(1)", "file:///data/data/tech.bbmfg.bizbill/files/x", "content://tech.bbmfg.bizbill.files/shared/x",
                "intent://scan/#Intent;scheme=zxing;end", "data:text/html,<script>alert(1)</script>", "http://wa.me/123",
                "https://evil.example/", "https://wa.me@evil.example/", "https://wa.me:8443/x", "market://details?id=x",
                "tel:;rm -rf", "mailto:a@b.c<script>", "upi://evil",
        };
        for (String u : blocked) assertNull(u, SafeUrl.external(u));
        String[] allowed = {"https://wa.me/919876543210", "tel:+919876543210", "mailto:owner@example.com", "https://github.com/arifmemon916-creator/bb-mfg/releases", "upi://pay?pa=shop@upi"};
        for (String u : allowed) assertNotNull(u, SafeUrl.external(u));
    }

    private static JSONObject meta() throws Exception {
        return new JSONObject()
                .put("packageName", "tech.bbmfg.bizbill")
                .put("latestVersionName", "3.6")
                .put("latestVersionCode", 14)
                .put("downloadUrl", "https://github.com/arifmemon916-creator/bb-mfg/releases/download/v3.6/BizBill-release.apk")
                .put("sha256", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
                .put("mandatoryUpdate", false)
                .put("minimumSupportedVersion", "3.0");
    }

    @Test
    public void updateMetadataValidation() throws Exception {
        UpdateManager.Meta m = UpdateManager.validateMetadata("tech.bbmfg.bizbill", "3.5", meta());
        assertEquals(14, m.versionCode);
        assertFalse(m.mandatory);
        assertTrue(UpdateManager.validateMetadata("tech.bbmfg.bizbill", "2.9", meta()).mandatory);
        assertTrue(UpdateManager.validateMetadata("tech.bbmfg.bizbill", "3.5", meta().put("mandatoryUpdate", true)).mandatory);
        expectReject(meta().put("packageName", "com.evil"), "package");
        expectReject(meta().put("latestVersionCode", "14"), "version code");
        expectReject(meta().put("latestVersionCode", -1), "version code");
        expectReject(meta().put("sha256", "abc"), "checksum");
        expectReject(meta().put("downloadUrl", "http://github.com/x.apk"), "trusted");
        expectReject(meta().put("downloadUrl", "https://evil.example/x.apk"), "trusted");
        expectReject(meta().put("downloadUrl", "https://github.com@evil.example/x.apk"), "trusted");
        expectReject(meta().put("minimumSupportedVersion", "latest"), "Minimum");
    }

    private static void expectReject(JSONObject o, String hint) {
        try {
            UpdateManager.validateMetadata("tech.bbmfg.bizbill", "3.5", o);
            fail("accepted invalid metadata: " + hint);
        } catch (UpdateManager.UpdateException e) {
            assertTrue(e.getMessage() + " should mention " + hint, e.getMessage().toLowerCase().contains(hint.toLowerCase()));
        }
    }

    @Test
    public void versionComparison() {
        assertEquals(1, UpdateManager.compareVersions("3.10", "3.9"));
        assertEquals(0, UpdateManager.compareVersions("3.5", "3.5.0"));
        assertEquals(-1, UpdateManager.compareVersions("2.9", "3.0"));
    }
}
