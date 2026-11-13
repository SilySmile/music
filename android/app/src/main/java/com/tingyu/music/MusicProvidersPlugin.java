package com.tingyu.music;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import org.json.JSONObject;
import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "MusicProviders", permissions = { @Permission(alias = "qrPhotos", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) })
public class MusicProvidersPlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    @PluginMethod public void saveLoginQr(PluginCall call) {
        if (Build.VERSION.SDK_INT <= 28 && getPermissionState("qrPhotos") != PermissionState.GRANTED) { requestPermissionForAlias("qrPhotos", call, "qrPhotoPermission"); return; }
        executor.execute(() -> { try { ProviderLoginUi.save(getContext(), call.getString("image", "")); call.resolve(); } catch (Exception error) { call.reject(error.getMessage() == null ? "二维码保存失败" : error.getMessage()); } });
    }
    @PermissionCallback private void qrPhotoPermission(PluginCall call) {
        if (getPermissionState("qrPhotos") != PermissionState.GRANTED) call.reject("未允许保存到相册，可使用分享二维码或截屏。");
        else saveLoginQr(call);
    }
    @PluginMethod public void openProviderApp(PluginCall call) {
        String provider = call.getString("provider", "");
        String packageName = provider.equals("qq") ? "com.tencent.qqmusic" : provider.equals("netease") ? "com.netease.cloudmusic" : "";
        if (packageName.isEmpty()) { call.reject("音乐平台无效"); return; }
        Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(packageName);
        if (intent == null) { call.reject("未找到官方 App，请先安装；也可分享二维码到另一台设备扫码。"); return; }
        try { getActivity().startActivity(intent); call.resolve(); } catch (Exception error) { call.reject("无法打开官方 App，请手动打开后使用扫一扫。"); }
    }
    @PluginMethod public void request(PluginCall call) {
        String id = call.getString("id", ""); if (!id.matches("[a-zA-Z0-9_-]{1,100}")) { call.reject("音源请求标识无效"); return; }
        executor.execute(() -> { try { JSONObject data = call.getObject("data"); call.resolve(new JSObject(ProviderApi.call(getContext(), call.getString("provider", ""), call.getString("action", ""), data == null ? new JSONObject() : data, id).toString())); } catch (Exception error) { call.reject(error.getMessage() == null ? "音乐平台请求失败" : error.getMessage()); } });
    }
    @PluginMethod public void cancel(PluginCall call) { ProviderApi.cancel(call.getString("id", "")); ProviderDownloads.cancel(call.getString("id", "")); call.resolve(); }
    @PluginMethod public void download(PluginCall call) { executor.execute(() -> { try { call.resolve(new JSObject(ProviderDownloads.download(getContext(), call.getString("id", ""), call.getString("provider", ""), call.getString("url", "")).toString())); } catch (Exception error) { call.reject(error.getMessage()); } }); }
    @PluginMethod public void downloadState(PluginCall call) { try { call.resolve(new JSObject(ProviderDownloads.state(call.getString("id", "")).toString())); } catch (Exception error) { call.reject(error.getMessage()); } }
    @PluginMethod public void readDownload(PluginCall call) { executor.execute(() -> { try { call.resolve(new JSObject(ProviderDownloads.read(call.getString("token", ""), call.getLong("offset", -1L), call.getInt("length", -1)).toString())); } catch (Exception error) { call.reject(error.getMessage()); } }); }
    @PluginMethod public void removeDownload(PluginCall call) { try { ProviderDownloads.remove(call.getString("token", "")); call.resolve(); } catch (Exception error) { call.reject(error.getMessage()); } }
    @Override protected void handleOnDestroy() { executor.shutdownNow(); }
}
