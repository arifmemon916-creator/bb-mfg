# JavaScript bridge methods are called by name from the WebView.
-keepclassmembers class tech.bbmfg.bizbill.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class tech.bbmfg.bizbill.LegacyDataExporter$ExportBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Strip debug / verbose / info logging from release builds.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
