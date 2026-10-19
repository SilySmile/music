package com.tingyu.music;

import android.content.Intent;
import android.os.Build;
import android.webkit.WebView;
import android.Manifest;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

@CapacitorPlugin(name = "BackgroundTasks", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class BackgroundTasksPlugin extends Plugin {
    private static BackgroundTasksPlugin instance;
    private static final ConcurrentHashMap<String, PluginCall> pending = new ConcurrentHashMap<>();
    private final CopyOnWriteArrayList<PluginCall> permissionWaiters = new CopyOnWriteArrayList<>();
    static void started(String identifier, String error) {
        PluginCall call = pending.remove(identifier);
        if (call != null) { if (error == null) call.resolve(); else call.reject(error); }
    }

    @Override public void load() { instance = this; }
    static void control(String action, String reason) {
        BackgroundTasksPlugin plugin = instance;
        if (plugin == null) return;
        JSObject value = new JSObject(); value.put("action", action); value.put("reason", reason);
        plugin.notifyListeners("control", value);
    }
    private String identifier(PluginCall call) throws Exception {
        String identifier = call.getString("id", "");
        if (!identifier.matches("[a-zA-Z0-9:_-]{1,120}")) throw new Exception("后台任务标识无效");
        return identifier;
    }
    @PluginMethod public void begin(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) { permissionWaiters.add(call); if (permissionWaiters.size() == 1) requestPermissionForAlias("notifications", call, "notificationResult"); return; }
        start(call);
    }
    @PermissionCallback private void notificationResult(PluginCall call) {
        for (PluginCall waiting : permissionWaiters) { if (getPermissionState("notifications") != PermissionState.GRANTED) waiting.reject("请允许任务通知权限，再启动锁屏后台任务。"); else start(waiting); }
        permissionWaiters.clear();
    }
    private void start(PluginCall call) {
        try {
            String identifier = identifier(call);
            if (pending.putIfAbsent(identifier, call) != null) throw new Exception("任务正在启动");
            Intent intent = new Intent(getContext(), BackgroundTaskService.class).setAction("begin");
            intent.putExtra("id", identifier); intent.putExtra("title", call.getString("title", "音乐任务"));
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent); else getContext().startService(intent);
            if (getActivity() != null) getActivity().runOnUiThread(() -> { if (Build.VERSION.SDK_INT >= 26 && getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false); });
        } catch (Exception error) { pending.values().remove(call); call.reject("无法启动后台任务服务，请返回应用前台后重试：" + error.getMessage()); }
    }
    @PluginMethod public void update(PluginCall call) {
        try { BackgroundTaskService.update(identifier(call), call.getString("message", "处理中")); call.resolve(); }
        catch (Exception error) { call.reject(error.getMessage()); }
    }
    @PluginMethod public void finish(PluginCall call) {
        try { BackgroundTaskService.finish(identifier(call)); call.resolve(); }
        catch (Exception error) { call.reject(error.getMessage()); }
    }
    @PluginMethod public void openPowerSettings(PluginCall call) {
        try { Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(intent); call.resolve(); }
        catch (Exception error) { call.reject("无法打开系统电池设置，请在系统设置中手动允许后台运行。"); }
    }
    @Override protected void handleOnResume() { control("foreground", ""); }
    @Override protected void handleOnDestroy() {
        if (instance == this) instance = null;
        for (PluginCall call : pending.values()) call.reject("任务页面已结束，请重新打开后继续。");
        pending.clear();
        for (PluginCall call : permissionWaiters) call.reject("任务页面已结束。"); permissionWaiters.clear();
        getContext().stopService(new Intent(getContext(), BackgroundTaskService.class));
    }
}
