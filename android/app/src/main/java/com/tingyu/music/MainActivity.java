package com.tingyu.music;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TransferFilesPlugin.class);
        registerPlugin(SecureConfigPlugin.class);
        registerPlugin(NativePlaybackPlugin.class);
        registerPlugin(AppUpdatesPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null) getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
}
