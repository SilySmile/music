package com.tingyu.music;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.Manifest;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativePlayback", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class NativePlaybackPlugin extends Plugin {
    private BroadcastReceiver receiver;

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                try { notifyListeners("state", new JSObject(intent.getStringExtra("state"))); }
                catch (Exception ignored) {}
            }
        };
        ContextCompat.registerReceiver(getContext(), receiver, new IntentFilter(MusicPlaybackService.STATE_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() { if (receiver != null) getContext().unregisterReceiver(receiver); }

    @PluginMethod
    public void notifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) requestPermissionForAlias("notifications", call, "notificationResult");
        else call.resolve();
    }

    @PermissionCallback
    private void notificationResult(PluginCall call) { call.resolve(); }

    private File audio(String identifier, boolean partial) throws Exception {
        if (identifier == null || !identifier.matches("[a-f0-9]{64}")) throw new Exception("无效的歌曲标识");
        File directory = new File(getContext().getFilesDir(), "playback-audio");
        if (!directory.exists() && !directory.mkdirs()) throw new Exception("无法创建后台音频目录，请检查空间");
        return new File(directory, identifier + (partial ? ".part" : ".audio"));
    }

    @PluginMethod
    public void cached(PluginCall call) {
        try {
            JSONArray tracks = call.getArray("tracks"); JSONArray present = new JSONArray();
            if (tracks == null) throw new Exception("队列为空");
            for (int index = 0; index < tracks.length(); index++) {
                JSONObject track = tracks.getJSONObject(index); File file = audio(track.getString("id"), false);
                if (file.isFile() && file.length() == SafeNumbers.fileOffset(track.opt("size"))) present.put(track.getString("id"));
            }
            JSObject result = new JSObject(); result.put("ids", present); call.resolve(result);
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            long offset = SafeNumbers.fileOffset(call.getData().opt("offset"));
            String data = call.getString("data", ""); if (data.length() > 8 * 1024 * 1024) throw new Exception("音频块过大");
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            try (RandomAccessFile output = new RandomAccessFile(audio(call.getString("id"), true), "rw")) {
                if (offset == 0) output.setLength(0);
                if (output.length() != offset) throw new Exception("后台音频块偏移不一致，请重试");
                output.seek(offset); output.write(bytes); output.getFD().sync();
            }
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        try {
            String identifier = call.getString("id"); File partial = audio(identifier, true); File target = audio(identifier, false);
            if (partial.length() != SafeNumbers.fileOffset(call.getData().opt("size"))) throw new Exception("后台音频长度校验失败");
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[1024 * 1024];
            try (FileInputStream input = new FileInputStream(partial)) { int length; while ((length = input.read(buffer)) != -1) digest.update(buffer, 0, length); }
            StringBuilder hash = new StringBuilder(); for (byte value : digest.digest()) hash.append(String.format("%02x", value & 0xff));
            if (!identifier.equals(hash.toString())) throw new Exception("后台音频 SHA-256 校验失败，原歌曲未改变");
            if (!partial.renameTo(target)) throw new Exception("后台音频提交失败");
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            for (boolean partial : new boolean[] { false, true }) { File file = audio(call.getString("id"), partial); if (file.exists() && !file.delete()) throw new Exception("后台音频副本清理失败"); }
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        try {
            JSONArray tracks = call.getArray("tracks"); if (tracks == null || tracks.length() == 0) throw new Exception("播放队列为空");
            for (int index = 0; index < tracks.length(); index++) if (!audio(tracks.getJSONObject(index).getString("id"), false).isFile()) throw new Exception("后台音频尚未准备完成，请保持应用前台稍候");
            File file = new File(getContext().getFilesDir(), "playback-queue.json");
            android.util.AtomicFile atomic = new android.util.AtomicFile(file); FileOutputStream stream = null;
            try { stream = atomic.startWrite(); stream.write(tracks.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(stream); }
            catch (Exception error) { if (stream != null) atomic.failWrite(stream); throw error; }
            Intent intent = new Intent(getContext(), MusicPlaybackService.class).setAction("queue");
            intent.putExtra("id", call.getString("id", ""));
            intent.putExtra("position", call.getDouble("position", 0d));
            intent.putExtra("playing", call.getBoolean("playing", true));
            intent.putExtra("mode", call.getString("mode", "list"));
            intent.putExtra("volume", call.getDouble("volume", 0.7d));
            intent.putExtra("fade", call.getInt("fade", 500));
            intent.putExtra("deadline", (double) SafeNumbers.fileOffset(call.getData().opt("deadline")));
            intent.putExtra("finishTrack", call.getBoolean("finishTrack", false));
            ContextCompat.startForegroundService(getContext(), intent); call.resolve();
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void control(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), MusicPlaybackService.class).setAction(call.getString("action", ""));
            Object value = call.getData().opt("value");
            double numeric = value instanceof Number ? ((Number) value).doubleValue() : 0d;
            if (Double.isNaN(numeric) || Double.isInfinite(numeric)) throw new Exception("无效的播放参数");
            intent.putExtra("value", numeric);
            intent.putExtra("text", call.getString("text", ""));
            getContext().startService(intent); call.resolve();
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void state(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            try { call.resolve(new JSObject(MusicPlaybackService.currentState().toString())); }
            catch (Exception error) { call.reject(error.getMessage()); }
        });
    }
}
