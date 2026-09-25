package tech.bbmfg.bizbill;

import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Prints an already generated PDF through Android's print framework. */
final class PdfPrintAdapter extends PrintDocumentAdapter {
    private final File pdf;
    private final String name;

    PdfPrintAdapter(File pdf, String name) {
        this.pdf = pdf;
        this.name = name;
    }

    @Override
    public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancel, LayoutResultCallback callback, Bundle extras) {
        if (cancel.isCanceled()) {
            callback.onLayoutCancelled();
            return;
        }
        callback.onLayoutFinished(new PrintDocumentInfo.Builder(name).setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(), true);
    }

    @Override
    public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancel, WriteResultCallback callback) {
        try (InputStream in = new FileInputStream(pdf); OutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0 && !cancel.isCanceled()) out.write(buf, 0, n);
            if (cancel.isCanceled()) callback.onWriteCancelled();
            else callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
        } catch (IOException e) {
            callback.onWriteFailed("Could not print the document");
        }
    }

    @Override
    public void onFinish() {
        //noinspection ResultOfMethodCallIgnored
        pdf.delete();
    }
}
