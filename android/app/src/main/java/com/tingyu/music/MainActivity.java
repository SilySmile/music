package com.tingyu.music;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TransferFilesPlugin.class);
        registerPlugin(BackgroundTasksPlugin.class);
        registerPlugin(SecureConfigPlugin.class);
        registerPlugin(NativePlaybackPlugin.class);
        registerPlugin(AppUpdatesPlugin.class);
        registerPlugin(DocumentLibraryPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
            LibraryMediaHandler media = new LibraryMediaHandler(this);
            getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    if (getBridge().getHost().equals(request.getUrl().getHost()) && getBridge().getScheme().equals(request.getUrl().getScheme()) && request.getUrl().getPath() != null && request.getUrl().getPath().startsWith(LibraryMediaHandler.PREFIX)) return media.handle(request);
                    return super.shouldInterceptRequest(view, request);
                }
            });
        }
    }
}
