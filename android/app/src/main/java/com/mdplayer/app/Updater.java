package com.mdplayer.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Автообновление из GitHub Releases (открытый репозиторий, токен не нужен).
 *
 * Релизы публикует GitHub Actions: тег v1.2.0-build7, файл mdplayer.apk.
 * Номер сборки (build7) совпадает с versionCode приложения — по нему и сравниваем.
 * Все сборки подписаны одним ключом, поэтому обновление ставится поверх, настройки сохраняются.
 */
final class Updater {
    private static final String LATEST = "https://api.github.com/repos/olddexen/mdplayer/releases/latest";
    private static final Pattern BUILD = Pattern.compile("build(\\d+)");
    private static final Pattern VERSION = Pattern.compile("(\\d+(?:\\.\\d+)+)");
    private static final long AUTO_INTERVAL_MS = 6 * 3600 * 1000L;   // автопроверка не чаще раза в 6 часов
    private static final long SNOOZE_MS = 3 * 24 * 3600 * 1000L;     // «Позже» — не напоминать 3 дня
    private static final int TIMEOUT_MS = 20000;
    private static final int DOWNLOAD_ATTEMPTS = 6;

    /** Опубликованная версия. */
    static final class Release {
        String version = "";
        int build;
        String notes = "";
        String apkUrl = "";
        long size;
    }

    private final Activity activity;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final SharedPreferences prefs;
    private boolean busy;
    private File pendingInstall;   // ждём, пока пользователь разрешит установку из этого приложения

    Updater(Activity activity) {
        this.activity = activity;
        this.prefs = activity.getSharedPreferences("mdplayer", Context.MODE_PRIVATE);
    }

    static int installedBuild(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    static String installedVersion(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    /** Проверка при запуске: тихо, не чаще раза в 6 часов. */
    void checkAuto() {
        long last = prefs.getLong("updateCheckedAt", 0);
        if (System.currentTimeMillis() - last < AUTO_INTERVAL_MS) return;
        check(false);
    }

    /** manual — по кнопке в настройках: сообщаем и «обновлений нет», и об ошибках. */
    void check(final boolean manual) {
        if (busy) return;
        busy = true;
        if (manual) toast("Проверяем обновления…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                Release release = null;
                String error = null;
                try {
                    release = parse(new JSONObject(get(LATEST)));
                } catch (IOException | JSONException e) {
                    error = e.getMessage();
                }
                final Release r = release;
                final String err = error;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        busy = false;
                        onChecked(r, err, manual);
                    }
                });
            }
        }, "update-check").start();
    }

    private void onChecked(Release release, String error, boolean manual) {
        if (activity.isFinishing()) return;
        if (error != null || release == null) {
            if (manual) toast("Не удалось проверить обновления: " + (error != null ? error : "нет данных"));
            return;
        }
        prefs.edit().putLong("updateCheckedAt", System.currentTimeMillis()).apply();
        if (!isNewer(release)) {
            if (manual) toast("У вас последняя версия mdplayer " + installedVersion(activity));
            return;
        }
        String snoozed = prefs.getString("updateSnoozed", "");
        long snoozedAt = prefs.getLong("updateSnoozedAt", 0);
        if (!manual && snoozed.equals(release.version + "#" + release.build)
                && System.currentTimeMillis() - snoozedAt < SNOOZE_MS) return;
        offer(release);
    }

    boolean isNewer(Release r) {
        int local = installedBuild(activity);
        if (r.build > 0 && local > 0) return r.build > local;
        return compareVersions(r.version, installedVersion(activity)) > 0;
    }

    private void offer(final Release release) {
        String notes = release.notes.length() > 700 ? release.notes.substring(0, 700) + "…" : release.notes;
        String message = "Версия " + release.version + (release.build > 0 ? " (сборка " + release.build + ")" : "")
                + "\nУстановлена: " + installedVersion(activity)
                + (notes.isEmpty() ? "\n\nНастройки, избранное и программа передач сохранятся." : "\n\n" + notes);
        AlertDialog dialog = new AlertDialog.Builder(activity, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Доступно обновление mdplayer")
                .setMessage(message)
                .setPositiveButton("Обновить", (d, w) -> download(release))
                .setNegativeButton("Позже", (d, w) -> prefs.edit()
                        .putString("updateSnoozed", release.version + "#" + release.build)
                        .putLong("updateSnoozedAt", System.currentTimeMillis())
                        .apply())
                .create();
        dialog.show();
        // пульт: OK сразу нажимает «Обновить». Обычный requestFocus() в «сенсорном» режиме не работает,
        // и первое нажатие OK лишь подсвечивало «Позже».
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).requestFocusFromTouch();
    }

    private void download(final Release release) {
        final ProgressDialog progress = new ProgressDialog(activity, AlertDialog.THEME_DEVICE_DEFAULT_DARK);
        progress.setTitle("Скачивание обновления");
        progress.setMessage("mdplayer " + release.version);
        progress.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progress.setIndeterminate(release.size <= 0);
        progress.setMax(100);
        progress.setCancelable(false);
        final boolean[] cancelled = {false};
        progress.setButton(ProgressDialog.BUTTON_NEGATIVE, "Отмена", (d, w) -> cancelled[0] = true);
        progress.show();

        new Thread(new Runnable() {
            @Override
            public void run() {
                File apk = null;
                String error = null;
                try {
                    apk = save(release, progress, cancelled);
                } catch (IOException e) {
                    error = e.getMessage();
                }
                final File file = apk;
                final String err = error;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            progress.dismiss();
                        } catch (IllegalArgumentException e) {
                            // окно уже закрыто
                        }
                        if (cancelled[0]) return;
                        if (file == null) toast("Не удалось скачать обновление: " + err);
                        else install(file);
                    }
                });
            }
        }, "update-download").start();
    }

    private File save(Release release, final ProgressDialog progress, boolean[] cancelled) throws IOException {
        File dir = ApkProvider.dir(activity);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("нет места для файла");
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        File target = new File(dir, "mdplayer-" + release.version.replaceAll("[^0-9.]", "") + "-" + release.build + ".apk");
        File part = new File(dir, target.getName() + ".part");

        // APK весит ~100 МБ, а связь с GitHub рвётся: докачиваем с места обрыва (Range)
        IOException last = null;
        for (int attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
            if (cancelled[0]) throw new IOException("отменено");
            try {
                saveChunk(release, part, progress, cancelled);
                if (release.size <= 0 || part.length() == release.size) {
                    last = null;
                    break;
                }
                last = new IOException("файл скачался не полностью");
            } catch (IOException e) {
                if (cancelled[0]) throw e;
                last = e;
            }
            try {
                Thread.sleep(2000L * attempt);
            } catch (InterruptedException e) {
                throw new IOException("прервано");
            }
        }
        if (last != null) {
            part.delete();
            throw new IOException(last.getMessage() + ", попробуйте ещё раз");
        }
        if (!part.renameTo(target)) throw new IOException("не удалось сохранить файл");
        return target;
    }

    /** Одна попытка: дописывает файл с его текущей длины (или сначала, если сервер не умеет докачку). */
    private void saveChunk(Release release, File part, final ProgressDialog progress, boolean[] cancelled) throws IOException {
        long have = part.isFile() ? part.length() : 0;
        if (release.size > 0 && have > release.size) {   // испорченный остаток — сначала
            part.delete();
            have = 0;
        }
        HttpURLConnection c = open(release.apkUrl);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        try {
            int code = c.getResponseCode();
            boolean append = code == 206 && have > 0;
            if (code == 416 && have > 0 && have == release.size) return;   // уже скачан целиком
            if (code != 200 && code != 206) throw new IOException("HTTP " + code);
            if (!append) have = 0;
            long total = release.size > 0 ? release.size : have + Math.max(0, c.getContentLength());
            InputStream in = c.getInputStream();
            OutputStream out = new FileOutputStream(part, append);
            try {
                byte[] buf = new byte[64 * 1024];
                long done = have;
                int lastPct = -1;
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancelled[0]) throw new IOException("отменено");
                    out.write(buf, 0, n);
                    done += n;
                    final int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    if (pct != lastPct) {
                        lastPct = pct;
                        ui.post(() -> progress.setProgress(pct));
                    }
                }
            } finally {
                out.close();
                in.close();
            }
        } finally {
            c.disconnect();
        }
    }

    /** Установка: на Android 8+ нужно разрешение «Установка неизвестных приложений» для mdplayer. */
    void install(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            pendingInstall = apk;
            toast("Разрешите mdplayer устанавливать обновления и вернитесь назад");
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())));
                return;
            } catch (ActivityNotFoundException e) {
                // на некоторых приставках такого экрана нет — пробуем установку напрямую
                pendingInstall = null;
            }
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(ApkProvider.uriFor(activity, apk), "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            toast("Не найден установщик приложений");
        }
    }

    /** Вернулись из настроек разрешений — продолжаем установку. */
    void onResume() {
        if (pendingInstall == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) return;
        File apk = pendingInstall;
        pendingInstall = null;
        if (apk.isFile()) install(apk);
    }

    // ---------- Сеть и разбор ----------

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "mdplayer-updater");
        c.setRequestProperty("Accept", "application/vnd.github+json, */*");
        return c;
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = open(url);
        try {
            int code = c.getResponseCode();
            if (code == 404) throw new IOException("релизов пока нет");
            if (code == 403) throw new IOException("GitHub временно ограничил запросы, попробуйте позже");
            if (code != 200) throw new IOException("GitHub: HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 2 * 1024 * 1024) throw new IOException("слишком большой ответ");
            }
            in.close();
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    static Release parse(JSONObject json) throws JSONException {
        Release r = new Release();
        String tag = json.optString("tag_name", "");
        Matcher b = BUILD.matcher(tag);
        if (b.find()) r.build = Integer.parseInt(b.group(1));
        Matcher v = VERSION.matcher(tag);
        if (v.find()) r.version = v.group(1);
        r.notes = json.optString("body", "").trim();
        JSONArray assets = json.optJSONArray("assets");
        for (int i = 0; assets != null && i < assets.length(); i++) {
            JSONObject a = assets.getJSONObject(i);
            if (a.optString("name", "").toLowerCase().endsWith(".apk")) {
                r.apkUrl = a.optString("browser_download_url", "");
                r.size = a.optLong("size", 0);
                break;
            }
        }
        if (r.apkUrl.isEmpty() || !r.apkUrl.startsWith("https://")) throw new JSONException("в релизе нет APK");
        return r;
    }

    /** 1.2.10 и 1.2.9 сравниваются по числам. */
    static int compareVersions(String a, String b) {
        String[] x = a.split("[.\\s(]");
        String[] y = b.split("[.\\s(]");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? toInt(x[i]) : 0;
            int q = i < y.length ? toInt(y[i]) : 0;
            if (p != q) return p > q ? 1 : -1;
        }
        return 0;
    }

    private static int toInt(String s) {
        try {
            return Integer.parseInt(s.replaceAll("[^0-9]", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void toast(String text) {
        Toast.makeText(activity, text, Toast.LENGTH_LONG).show();
    }
}
