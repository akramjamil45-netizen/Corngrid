package com.corngrid.app;

import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * CornGrid launcher activity — a native shell around the live https://corngrid.com
 * web platform (Capacitor 8 remote WebView). The site owns all product logic
 * (authentication, dashboard, market data, uploads); this class adds only what a
 * native Android app requires:
 *
 * - Back button: WebView history first, minimize at the app root (no accidental
 *   exits, no trap; the session stays alive in recents).
 * - Loading: thin gold progress bar pinned to the top of the window.
 * - Offline/errors: branded full-screen overlay with retry. Connectivity loss is
 *   detected natively; reconnecting reloads the page so trading data is never
 *   presented as live when it is stale.
 * - Downloads: DownloadManager for plain http(s) file links (session cookies
 *   attached) plus an injected JS hook that saves the site's authenticated blob
 *   downloads (preset .set files, setup-guide PDF, trade CSV exports) into the
 *   system Downloads collection.
 */
public class MainActivity extends BridgeActivity {

    /**
     * Injected into every page load — the site's own source is never modified.
     * Intercepts clicks on a[download] elements whose href is a blob: URL, both
     * for real user taps (capture-phase listener) and for programmatic
     * link.click() (prototype override, which also covers the detached anchor the
     * CSV exporter uses). The blob is fetched in-page and handed to the native
     * CornGridBridge.saveBlob() as base64. evaluateJavascript is not subject to
     * page CSP, and blob: URLs are same-origin, so no server changes are needed.
     */
    private static final String BLOB_HOOK_JS =
            "(function(){try{"
          + "if(window.__cgBlobHook){return;}"
          + "window.__cgBlobHook=1;"
          + "var save=function(a){var href=a.getAttribute('href')||'';"
          + "if(href.indexOf('blob:')!==0){return false;}"
          + "var name=a.getAttribute('download')||'download';"
          + "fetch(href).then(function(res){return res.blob();}).then(function(blob){"
          + "var reader=new FileReader();"
          + "reader.onload=function(){var url=String(reader.result||'');"
          + "var idx=url.indexOf(',');var b64=idx>=0?url.slice(idx+1):'';"
          + "if(window.CornGridBridge&&window.CornGridBridge.saveBlob){"
          + "window.CornGridBridge.saveBlob(name,blob.type||'application/octet-stream',b64);}};"
          + "reader.readAsDataURL(blob);}).catch(function(){});"
          + "return true;};"
          + "var origClick=HTMLAnchorElement.prototype.click;"
          + "HTMLAnchorElement.prototype.click=function(){"
          + "try{if(save(this)){return;}}catch(e){}"
          + "return origClick.apply(this,arguments);};"
          + "document.addEventListener('click',function(ev){"
          + "try{var t=ev.target;var a=(t&&t.closest)?t.closest('a[download]'):null;"
          + "if(!a){return;}"
          + "if(save(a)){ev.preventDefault();ev.stopPropagation();}}"
          + "catch(e){}},true);"
          + "}catch(err){}})();";
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();

    private ProgressBar pageProgress;
    private View offlineOverlay;
    private TextView offlineMessage;
    private boolean offlineVisible = false;
    private boolean loadHadError = false;
    private ConnectivityManager.NetworkCallback networkCallback;

    private final Runnable progressTicker = new Runnable() {
        @Override
        public void run() {
            if (pageProgress == null || pageProgress.getVisibility() != View.VISIBLE) {
                return;
            }
            WebView webView = bridge != null ? bridge.getWebView() : null;
            if (webView != null) {
                pageProgress.setProgress(webView.getProgress());
            }
            mainHandler.postDelayed(this, 150);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (bridge == null || bridge.getWebView() == null) {
            // WebView could not be created; Capacitor's fallback layout is visible.
            return;
        }

        installBackButtonHandler();
        installOverlays();
        installWebViewIntegration();
        installNetworkObserver();
    }

    @Override
    public void onDestroy() {
        if (networkCallback != null) {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                try {
                    cm.unregisterNetworkCallback(networkCallback);
                } catch (IllegalArgumentException ignored) {
                    // Callback was never registered or is already removed.
                }
            }
            networkCallback = null;
        }
        mainHandler.removeCallbacksAndMessages(null);
        ioExecutor.shutdown();
        super.onDestroy();
    }

    /**
     * Sole authority for the hardware back button — Capacitor's App plugin default
     * handler is disabled via plugins.App.disableBackButtonHandler, so callback
     * ordering can never be ambiguous. Walk WebView history; at the app root,
     * minimize instead of exiting so an accidental press never ends the session.
     */
    private void installBackButtonHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }
    /** Adds the top progress bar and the full-screen offline overlay above the WebView. */
    private void installOverlays() {
        ViewGroup content = findViewById(android.R.id.content);

        pageProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        pageProgress.setMax(100);
        pageProgress.setIndeterminate(false);
        pageProgress.setProgressTintList(ColorStateList.valueOf(0xFFFFD400));
        pageProgress.setElevation(dp(8));
        pageProgress.setVisibility(View.GONE);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        content.addView(pageProgress, progressParams);

        offlineOverlay = LayoutInflater.from(this).inflate(R.layout.cg_offline_overlay, content, false);
        offlineOverlay.setVisibility(View.GONE);
        content.addView(offlineOverlay);
        offlineMessage = offlineOverlay.findViewById(R.id.cg_offline_message);

        Button retry = offlineOverlay.findViewById(R.id.cg_offline_retry);
        retry.setOnClickListener(v -> {
            WebView webView = bridge != null ? bridge.getWebView() : null;
            if (webView == null) {
                return;
            }
            loadHadError = false;
            hideOfflineOverlay();
            showProgress();
            webView.reload();
        });
    }

    private void showProgress() {
        if (pageProgress == null) {
            return;
        }
        if (pageProgress.getVisibility() != View.VISIBLE) {
            pageProgress.setProgress(5);
            pageProgress.setVisibility(View.VISIBLE);
        }
        mainHandler.removeCallbacks(progressTicker);
        mainHandler.post(progressTicker);
    }

    private void hideProgress() {
        if (pageProgress == null) {
            return;
        }
        mainHandler.removeCallbacks(progressTicker);
        pageProgress.setProgress(100);
        pageProgress.setVisibility(View.GONE);
    }

    private void showOfflineOverlay(String message) {
        if (offlineOverlay == null || offlineMessage == null) {
            return;
        }
        offlineMessage.setText(message);
        if (!offlineVisible) {
            offlineOverlay.setVisibility(View.VISIBLE);
            offlineVisible = true;
        }
    }

    private void hideOfflineOverlay() {
        if (offlineOverlay == null || !offlineVisible) {
            return;
        }
        offlineOverlay.setVisibility(View.GONE);
        offlineVisible = false;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
    /** Wires the custom WebViewClient, the blob-save bridge and the download listener. */
    private void installWebViewIntegration() {
        WebView webView = bridge.getWebView();

        // Main-frame error detection, progress events and blob-hook injection.
        bridge.setWebViewClient(new CornGridWebViewClient(bridge));

        // Authenticated downloads are produced in-page as blob: URLs; the injected
        // hook hands them to this native bridge for saving.
        webView.addJavascriptInterface(new BlobSaveBridge(), "CornGridBridge");

        // Direct http(s) links to files the WebView cannot render (PDF/archives)
        // go to the system DownloadManager with the site's session cookies.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url == null || !url.startsWith("http")) {
                return; // blob:/data: downloads are handled by the injected JS hook.
            }
            startHttpDownload(url, userAgent, contentDisposition, mimeType);
        });
    }

    /**
     * Shows the offline overlay as soon as the default network drops and reloads
     * when it returns, so cached values are never mistaken for live trading data.
     */
    private void installNetworkObserver() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runOnUiThread(() -> {
                    if (!offlineVisible) {
                        return;
                    }
                    WebView webView = bridge != null ? bridge.getWebView() : null;
                    loadHadError = false;
                    hideOfflineOverlay();
                    if (webView != null) {
                        showProgress();
                        webView.reload();
                    }
                });
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(() -> showOfflineOverlay(getString(R.string.cg_offline_no_network)));
            }
        };
        try {
            cm.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
            // Callback limit reached; offline detection degrades to WebView errors only.
        }
    }

    /** Enqueues a system download with the current session cookies attached. */
    private void startHttpDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String fileName = sanitizeFileName(URLUtil.guessFileName(url, contentDisposition, mimeType));
            if (mimeType != null && !mimeType.isEmpty()) {
                request.setMimeType(mimeType);
            }
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) {
                request.addRequestHeader("Cookie", cookies);
            }
            if (userAgent != null && !userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= 29) {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            } else {
                // App-specific external storage needs no permission below API 29.
                request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
            }
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                throw new IllegalStateException("DownloadManager unavailable");
            }
            dm.enqueue(request);
            Toast.makeText(this, R.string.cg_download_started, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, R.string.cg_download_failed, Toast.LENGTH_SHORT).show();
        }
    }

    /** Strips paths and control characters so downloads can never escape their directory. */
    private static String sanitizeFileName(String name) {
        String cleaned = name == null ? "" : name.replace('\\', '/');
        int slash = cleaned.lastIndexOf('/');
        if (slash >= 0) {
            cleaned = cleaned.substring(slash + 1);
        }
        cleaned = cleaned.replaceAll("[\\x00-\\x1f<>:\"|?*]", "_").trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) {
            cleaned = "download";
        }
        return cleaned;
    }
    /** Captures main-frame failures, drives the progress bar and injects the blob hook. */
    private class CornGridWebViewClient extends BridgeWebViewClient {

        CornGridWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            loadHadError = false;
            showProgress();
            view.evaluateJavascript(BLOB_HOOK_JS, null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            view.evaluateJavascript(BLOB_HOOK_JS, null);
            hideProgress();
            if (!loadHadError) {
                hideOfflineOverlay();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            boolean mainFrame = request != null && request.isForMainFrame();
            if (mainFrame) {
                int code = error.getErrorCode();
                String desc = error.getDescription() != null ? error.getDescription().toString() : "";
                // ERROR_UNKNOWN usually means the load was superseded (for example by
                // a download); genuine connectivity failures carry specific codes and
                // are additionally covered by the network callback.
                if (code != WebViewClient.ERROR_UNKNOWN && !desc.contains("ERR_ABORTED")) {
                    loadHadError = true;
                    showOfflineOverlay(getString(R.string.cg_offline_server));
                }
            }
            super.onReceivedError(view, request, error);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            boolean mainFrame = request != null && request.isForMainFrame();
            if (mainFrame && errorResponse.getStatusCode() >= 500) {
                loadHadError = true;
                showOfflineOverlay(getString(R.string.cg_offline_http_error, errorResponse.getStatusCode()));
            }
            super.onReceivedHttpError(view, request, errorResponse);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean handled = super.onRenderProcessGone(view, detail);
            if (!handled) {
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, R.string.cg_render_gone, Toast.LENGTH_LONG).show();
                    recreate();
                });
            }
            return true;
        }
    }
    /**
     * Exposed to page JavaScript as window.CornGridBridge. Calls arrive on a
     * WebView-managed background thread; file IO runs on the single-thread
     * executor and results are announced on the UI thread.
     */
    public class BlobSaveBridge {

        @JavascriptInterface
        public void saveBlob(String name, String mimeType, String base64Data) {
            String safeName = sanitizeFileName(
                    name == null || name.trim().isEmpty() ? "download" : name);
            String mime = mimeType == null || mimeType.trim().isEmpty()
                    ? "application/octet-stream" : mimeType;
            String data = base64Data == null ? "" : base64Data;
            ioExecutor.execute(() -> saveBlobFile(safeName, mime, data));
        }
    }

    /**
     * API 29+: MediaStore.Downloads (no permissions required). Older devices:
     * the app-specific external Downloads directory (also permission-free).
     * Large files would need chunking through the JS bridge; current authenticated
     * downloads (presets, guide, CSVs) are all well under 2 MB.
     */
    private void saveBlobFile(String fileName, String mimeType, String base64Data) {
        try {
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    throw new IllegalStateException("MediaStore insert failed");
                }
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        throw new IllegalStateException("No output stream");
                    }
                    out.write(bytes);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, values, null, null);
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) {
                    dir = getFilesDir();
                }
                try (FileOutputStream out = new FileOutputStream(new File(dir, fileName))) {
                    out.write(bytes);
                }
            }
            runOnUiThread(() -> Toast.makeText(this,
                    getString(R.string.cg_file_saved, fileName), Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this,
                    R.string.cg_file_save_failed, Toast.LENGTH_SHORT).show());
        }
    }
}
