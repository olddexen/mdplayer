package com.mdplayer.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * mdplayer для Android без Termux.
 * Внутри приложения запускается Node.js (nodejs-mobile) с сервером mdplayer из assets/nodejs-project,
 * а WebView показывает его веб-интерфейс — так же, как Chrome в варианте с Termux.
 */
public class MainActivity extends Activity {
    private static final int PORT = 8090;   // не 8080 — чтобы не мешать mdplayer, запущенному в Termux
    private static final String HOME = "http://127.0.0.1:" + PORT + "/";
    private static final String PROJECT = "nodejs-project";
    private static final long START_TIMEOUT_MS = 60000;
    private static final int FILE_REQUEST = 1;
    private static final int MATCH = FrameLayout.LayoutParams.MATCH_PARENT;

    private static boolean nodeStarted = false;   // Node.js можно запустить только один раз за процесс

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    /** Запуск Node.js с аргументами командной строки (native-lib.cpp). Не возвращается, пока сервер работает. */
    private static native int startNode(String[] arguments);

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(MATCH, MATCH));
        setContentView(root);

        setupWebView();
        showMessage("Запуск mdplayer…");
        startNodeOnce(getApplicationContext());
        waitForServer();
    }

    private void setupWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);                  // localStorage: избранное, выбранная группа
        settings.setMediaPlaybackRequiresUserGesture(false);  // канал запускается сразу после выбора
        web.setBackgroundColor(0xFF0E1116);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith(HOME)) return false;
                openExternal(url);   // кнопка ↗ (intent:) и прочие внешние ссылки
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url.startsWith(HOME)) view.clearHistory();   // «Назад» не возвращает к заставке
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // Выбор файла плейлиста в настройках
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    toast("Не найдено приложение для выбора файла");
                    return false;
                }
            }

            // Кнопка «во весь экран» в плеере
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(MATCH, MATCH));
                web.setVisibility(View.GONE);
                hideSystemBars(true);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen(false);
            }
        });
    }

    private void exitFullscreen(boolean notifyPage) {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        web.setVisibility(View.VISIBLE);
        hideSystemBars(false);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (notifyPage && fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    private void hideSystemBars(boolean hide) {
        int flags = hide
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                : View.SYSTEM_UI_FLAG_VISIBLE;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    /** intent:-ссылка от кнопки ↗ (VLC, MX Player…) или обычная ссылка — в другое приложение. */
    private void openExternal(String url) {
        try {
            Intent intent = url.startsWith("intent:")
                    ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                    : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.setComponent(null);
            intent.setSelector(null);
            startActivity(Intent.createChooser(intent, "Открыть в…"));
        } catch (Exception e) {
            toast("Не найдено приложение, чтобы открыть ссылку");
        }
    }

    // ---------- Node.js ----------

    private static void startNodeOnce(final Context context) {
        if (nodeStarted) return;
        nodeStarted = true;
        Runnable run = new Runnable() {
            @Override
            public void run() {
                File project = new File(context.getFilesDir(), PROJECT);
                try {
                    if (assetsOutdated(context, project)) {
                        copyAssets(context.getAssets(), PROJECT, project);
                        markAssetsCopied(context);
                    }
                } catch (IOException e) {
                    nodeStarted = false;
                    return;
                }
                startNode(new String[]{"node", new File(project, "server.js").getAbsolutePath(),
                        "--port", String.valueOf(PORT)});
            }
        };
        new Thread(null, run, "nodejs", 8 * 1024 * 1024).start();   // Node.js нужен большой стек
    }

    /** Файлы сервера распаковываются заново только после установки новой версии APK. */
    private static long apkTime(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    private static boolean assetsOutdated(Context context, File project) {
        SharedPreferences prefs = context.getSharedPreferences("mdplayer", MODE_PRIVATE);
        return prefs.getLong("assetsTime", -1) != apkTime(context) || !new File(project, "server.js").exists();
    }

    private static void markAssetsCopied(Context context) {
        context.getSharedPreferences("mdplayer", MODE_PRIVATE).edit().putLong("assetsTime", apkTime(context)).apply();
    }

    /** Копирует папку из assets. config.json и data/ не трогаются — их в assets нет. */
    private static void copyAssets(AssetManager assets, String path, File target) throws IOException {
        String[] children = assets.list(path);
        if (children == null || children.length == 0) {
            File parent = target.getParentFile();
            if (parent != null) parent.mkdirs();
            InputStream in = assets.open(path);
            OutputStream out = new FileOutputStream(target);
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            in.close();
            out.close();
            return;
        }
        target.mkdirs();
        for (String child : children) copyAssets(assets, path + "/" + child, new File(target, child));
    }

    /** Ждём, пока сервер начнёт отвечать, и открываем интерфейс. */
    private void waitForServer() {
        final long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
        new Thread(new Runnable() {
            @Override
            public void run() {
                while (System.currentTimeMillis() < deadline) {
                    if (serverResponds()) {
                        ui.post(new Runnable() {
                            @Override
                            public void run() {
                                web.loadUrl(HOME);
                            }
                        });
                        return;
                    }
                    try {
                        Thread.sleep(300);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        showMessage("Сервер mdplayer не запустился. Закройте приложение (уберите из недавних) и откройте снова.");
                    }
                });
            }
        }).start();
    }

    private static boolean serverResponds() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(HOME + "api/state").openConnection();
            connection.setConnectTimeout(500);
            connection.setReadTimeout(2000);
            return connection.getResponseCode() > 0;
        } catch (IOException e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ---------- Разное ----------

    private void showMessage(String text) {
        String html = "<html><head><meta name='viewport' content='width=device-width'></head>"
                + "<body style='margin:0;height:100%;background:#0e1116;color:#9aa4af;font:16px sans-serif;"
                + "display:flex;align-items:center;justify-content:center;text-align:center;padding:24px'>"
                + text.replace("<", "&lt;") + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) exitFullscreen(true);
        else if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);   // сервер продолжает работать; закрыть — из списка недавних приложений
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
