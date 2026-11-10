package com.mdplayer.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.regex.Pattern;

/**
 * Отдаёт скачанное обновление (cacheDir/updates/*.apk) установщику пакетов по ссылке content://.
 * Android 7+ не разрешает передавать другим приложениям ссылки file://.
 * Только чтение и только файлы обновлений — ничего другого через этот провайдер не получить.
 */
public class ApkProvider extends ContentProvider {
    static final String AUTHORITY_SUFFIX = ".updates";
    private static final String APK_TYPE = "application/vnd.android.package-archive";
    private static final Pattern NAME = Pattern.compile("^mdplayer-[0-9A-Za-z._-]+\\.apk$");

    static Uri uriFor(android.content.Context context, File apk) {
        return Uri.parse("content://" + context.getPackageName() + AUTHORITY_SUFFIX + "/" + apk.getName());
    }

    static File dir(android.content.Context context) {
        return new File(context.getCacheDir(), "updates");
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || !NAME.matcher(name).matches()) throw new FileNotFoundException("Нет такого файла");
        File file = new File(dir(getContext()), name);
        if (!file.isFile()) throw new FileNotFoundException("Нет такого файла");
        return file;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Только чтение");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return APK_TYPE;
    }

    /** Установщик спрашивает имя и размер файла. */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{file.getName(), file.length()});
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
