package com.tingyu.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import java.util.LinkedHashMap;
import java.util.Map;

public class BackgroundTaskService extends Service {
    private static BackgroundTaskService instance;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, String> tasks = new LinkedHashMap<>();
    private PowerManager.WakeLock wakeLock;
    private final Runnable renew = new Runnable() {
        @Override public void run() {
            if (tasks.isEmpty()) return;
            wakeLock.acquire(120000); handler.postDelayed(this, 60000);
        }
    };
    @Override public void onCreate() {
        super.onCreate(); instance = this;
        if (Build.VERSION.SDK_INT >= 26) ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel("background-tasks", "后台传输与处理", NotificationManager.IMPORTANCE_LOW));
        wakeLock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":background-tasks");
        wakeLock.setReferenceCounted(false);
    }
    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 201, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pause = PendingIntent.getService(this, 202, new Intent(this, BackgroundTaskService.class).setAction("pause"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String detail = tasks.isEmpty() ? "正在结束任务" : tasks.values().iterator().next();
        return new NotificationCompat.Builder(this, "background-tasks").setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("弦栖霁 · " + tasks.size() + " 个后台任务").setContentText(detail).setStyle(new NotificationCompat.BigTextStyle().bigText(detail)).setContentIntent(content).setOngoing(true).setOnlyAlertOnce(true).addAction(android.R.drawable.ic_media_pause, "暂停全部", pause).build();
    }
    private void refresh() { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(1202, notification()); }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        if ("pause".equals(intent.getAction())) { pause("已通过通知栏暂停任务，请返回任务中心继续。"); return START_NOT_STICKY; }
        String identifier = intent.getStringExtra("id");
        String title = intent.getStringExtra("title");
        if (identifier == null || !identifier.matches("[a-zA-Z0-9:_-]{1,120}") || !tasks.containsKey(identifier) && tasks.size() >= 32) { if (identifier != null) BackgroundTasksPlugin.started(identifier, "后台任务过多，请等待现有任务完成。"); if (tasks.isEmpty()) stopSelf(startId); return START_NOT_STICKY; }
        tasks.put(identifier, title == null ? "音乐任务" : title.substring(0, Math.min(title.length(), 200)));
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1202, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); else startForeground(1202, notification());
            handler.removeCallbacks(renew); renew.run();
            BackgroundTasksPlugin.started(identifier, null);
        } catch (Exception error) { BackgroundTasksPlugin.started(identifier, "系统不允许后台任务，请回到前台后重试。"); pause("系统不允许后台任务，请回到前台后重试。"); }
        return START_NOT_STICKY;
    }
    static void update(String identifier, String message) {
        BackgroundTaskService service = instance;
        if (service != null) service.handler.post(() -> { if (service.tasks.containsKey(identifier)) { service.tasks.put(identifier, message.substring(0, Math.min(message.length(), 300))); service.refresh(); } });
    }
    static void finish(String identifier) {
        BackgroundTaskService service = instance;
        if (service != null) service.handler.post(() -> { service.tasks.remove(identifier); if (service.tasks.isEmpty()) service.stopSelf(); else service.refresh(); });
    }
    private void pause(String reason) { NativeSourceDownloads.pauseAll(); BackgroundTasksPlugin.control("pause", reason); tasks.clear(); stopSelf(); }
    @Override public void onTimeout(int startId, int foregroundServiceType) { pause("系统后台数据处理时限已到，已暂停；请回到前台后继续，不会自动重发付费 AI 请求。"); }
    @Override public void onTaskRemoved(Intent rootIntent) { pause("应用已从最近任务移除，进度保留；重新打开后手动继续。"); }
    @Override public void onDestroy() {
        NativeSourceDownloads.pauseAll();
        handler.removeCallbacksAndMessages(null);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE); if (instance == this) instance = null; super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
