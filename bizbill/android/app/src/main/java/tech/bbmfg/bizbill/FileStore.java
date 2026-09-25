package tech.bbmfg.bizbill;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** App-private file locations. Only cache/shared and cache/camera are shareable. */
final class FileStore {
    private FileStore() {}

    static File sharedDir(Context c) {
        return dir(new File(c.getCacheDir(), "shared"));
    }

    static File cameraDir(Context c) {
        return dir(new File(c.getCacheDir(), "camera"));
    }

    static File printDir(Context c) {
        return dir(new File(c.getCacheDir(), "print"));
    }

    static File updatesDir(Context c) {
        return dir(new File(c.getCacheDir(), "updates"));
    }

    /** Internal storage (not shareable, excluded from Android backup). */
    static File backupsDir(Context c) {
        return dir(new File(c.getFilesDir(), "backups"));
    }

    static File legacyDir(Context c) {
        return dir(new File(c.getFilesDir(), "legacy"));
    }

    private static File dir(File f) {
        if (!f.exists() && !f.mkdirs()) Log.d("mkdirs failed: " + f.getName());
        return f;
    }

    /** New unique temp file inside a unique sub-folder (keeps the user-facing name). */
    static File newSharedFile(Context c, String safeName) {
        File d = dir(new File(sharedDir(c), UUID.randomUUID().toString()));
        return new File(d, safeName);
    }

    static void write(File f, byte[] bytes) throws IOException {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
        }
    }

    static void writeAtomically(File target, String text) throws IOException {
        File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
        if (!tmp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("rename failed");
        }
    }

    static void cleanTemp(Context c, long olderThanMs) {
        long cutoff = System.currentTimeMillis() - olderThanMs;
        for (File d : new File[]{sharedDir(c), cameraDir(c), printDir(c), updatesDir(c)}) deleteOld(d, cutoff, false);
    }

    private static void deleteOld(File f, long cutoff, boolean self) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteOld(k, cutoff, true);
        if (self && f.lastModified() < cutoff) {
            File[] rest = f.listFiles();
            if (rest == null || rest.length == 0) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }
}
