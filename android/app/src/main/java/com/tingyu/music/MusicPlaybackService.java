package com.tingyu.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.util.LinkedHashSet;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;

public class MusicPlaybackService extends Service {
    public static final String STATE_ACTION = "com.tingyu.music.PLAYBACK_STATE";
    private static MusicPlaybackService instance;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaPlayer player;
    private MediaSession session;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private JSONArray queue = new JSONArray();
    private int index = 0;
    private boolean prepared = false;
    private boolean wanted = false;
    private String mode = "list";
    private float volume = 0.7f;
    private float gain = 1f;
    private int fade = 500;
    private int fadeRevision = 0;
    private long deadline = 0;
    private boolean finishTrack = false;
    private String error = "";
    private final java.util.ArrayList<Integer> shuffleBag = new java.util.ArrayList<>();
    private final LinkedHashSet<String> cloudPlayed = new LinkedHashSet<>();
    private void saveCloudPlayed() { getSharedPreferences("cloud-played", MODE_PRIVATE).edit().putString("ids", new JSONArray(cloudPlayed).toString()).apply(); }
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() { @Override public void onReceive(Context context, Intent intent) { pause(true); } };
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) pause(true);
        else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) { gain = 0.2f; applyVolume(); }
        else if (change == AudioManager.AUDIOFOCUS_GAIN) { gain = 1f; applyVolume(); }
    };

    public static JSONObject currentState() {
        if (instance == null) { JSONObject state = new JSONObject(); try { state.put("active", false); } catch (Exception ignored) {} return state; }
        return instance.state();
    }

    private JSONObject track() { JSONObject track = queue.optJSONObject(index); return track == null ? new JSONObject() : track; }
    private boolean playing() { try { return prepared && player != null && player.isPlaying(); } catch (Exception ignored) { return false; } }
    private JSONObject state() {
        JSONObject state = new JSONObject();
        try {
            state.put("active", queue.length() > 0); state.put("id", track().optString("id")); state.put("playing", playing());
            state.put("position", prepared && player != null ? player.getCurrentPosition() / 1000d : 0);
            state.put("duration", prepared && player != null ? player.getDuration() / 1000d : track().optDouble("duration", 0));
            state.put("mode", mode); state.put("volume", volume); state.put("error", error);
            state.put("deadline", deadline); state.put("finishTrack", finishTrack);
            state.put("cloudPlayed", new JSONArray(cloudPlayed));
        } catch (Exception ignored) {}
        return state;
    }

    @Override
    public void onCreate() {
        super.onCreate(); instance = this; audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        try { JSONArray ids = new JSONArray(getSharedPreferences("cloud-played", MODE_PRIVATE).getString("ids", "[]")); for (int position = 0; position < ids.length(); position++) { String id = ids.getString(position); if (id.matches("[a-f0-9]{64}") && cloudPlayed.size() < 5000) cloudPlayed.add(id); } } catch (Exception ignored) {}
        if (Build.VERSION.SDK_INT >= 26) {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel("music-playback", "音乐播放", NotificationManager.IMPORTANCE_LOW));
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()).setOnAudioFocusChangeListener(focusListener).build();
        }
        session = new MediaSession(this, "弦栖霁");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { play(); }
            @Override public void onPause() { pause(false); }
            @Override public void onSkipToNext() { advance(1, false); }
            @Override public void onSkipToPrevious() { advance(-1, false); }
            @Override public void onSeekTo(long position) { seek(position); }
            @Override public void onStop() { pause(true); }
        });
        session.setActive(true);
        ContextCompat.registerReceiver(this, noisyReceiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED);
        startForeground(10, notification());
        handler.post(new Runnable() { @Override public void run() { checkSleep(false); broadcast(); handler.postDelayed(this, 500); } });
    }

    private PendingIntent action(String action, int request) { return PendingIntent.getService(this, request, new Intent(this, MusicPlaybackService.class).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE); }
    private Notification notification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "music-playback") : new Notification.Builder(this);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return builder.setSmallIcon(com.tingyu.music.R.drawable.tingyu_icon).setContentTitle(track().optString("title", "弦栖霁"))
            .setContentText(track().optString("artist", "后台音乐播放")).setContentIntent(open).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true).setOngoing(playing())
            .addAction(android.R.drawable.ic_media_previous, "上一首", action("previous", 1))
            .addAction(playing() ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing() ? "暂停" : "播放", action("toggle", 2))
            .addAction(android.R.drawable.ic_media_next, "下一首", action("next", 3))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止播放服务", action("stop", 4))
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2)).build();
    }

    private void broadcast() {
        JSONObject state = state();
        sendBroadcast(new Intent(STATE_ACTION).setPackage(getPackageName()).putExtra("state", state.toString()));
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions).setState(playing() ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, (long) (state.optDouble("position") * 1000), playing() ? 1f : 0f).build());
    }
    private void refresh() { if (session != null) { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(10, notification()); broadcast(); } }
    private void applyVolume() { if (player != null) { try { player.setVolume(volume * gain, volume * gain); } catch (Exception ignored) {} } }

    private void ramp(float target, Runnable finished) {
        int revision = ++fadeRevision; long started = android.os.SystemClock.elapsedRealtime(); float initial = gain;
        handler.post(new Runnable() { @Override public void run() {
            if (revision != fadeRevision || player == null) return;
            float progress = fade <= 0 ? 1f : Math.min(1f, (android.os.SystemClock.elapsedRealtime() - started) / (float) fade);
            gain = initial + (target - initial) * progress * progress * (3f - 2f * progress); applyVolume();
            if (progress < 1f) handler.postDelayed(this, 16); else if (finished != null) finished.run();
        } });
    }

    private boolean focus() {
        int result = Build.VERSION.SDK_INT >= 26 ? audioManager.requestAudioFocus(focusRequest) : audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }
    private void play() {
        wanted = true;
        if (!prepared || player == null) return;
        if (!focus()) { error = "未获得音频焦点，请稍后重试"; wanted = false; refresh(); return; }
        try { if (player.getCurrentPosition() >= player.getDuration()) player.seekTo(0); if (!playing()) gain = fade > 0 ? 0f : 1f; player.start(); ramp(1f, null); error = ""; refresh(); }
        catch (Exception failure) { error = "播放失败：" + failure.getMessage(); wanted = false; refresh(); }
    }
    private void pause(boolean immediate) {
        wanted = false; fadeRevision++;
        if (!prepared || player == null) { refresh(); return; }
        Runnable stop = () -> { try { if (player != null && player.isPlaying()) player.pause(); } catch (Exception ignored) {} gain = 1f; applyVolume(); refresh(); };
        if (immediate || !playing()) stop.run(); else ramp(0f, stop);
    }
    private void seek(long position) { if (prepared && player != null) { player.seekTo((int) Math.max(0, Math.min(position, player.getDuration()))); broadcast(); } }

    private void select(String identifier, double position, boolean start) {
        for (int candidate = 0; candidate < queue.length(); candidate++) if (queue.optJSONObject(candidate).optString("id").equals(identifier)) { index = candidate; break; }
        fadeRevision++; if (player != null) { player.release(); player = null; } prepared = false; wanted = start; error = "";
        try {
            String id = track().getString("id"); if (!id.matches("[a-f0-9]{64}")) throw new Exception("无效歌曲");
            player = new MediaPlayer(); player.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
            player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
            File cached = new File(getFilesDir(), "playback-audio/" + id + ".audio");
            boolean remote = !cached.isFile() && track().has("sourceUrl");
            if (remote) player.setDataSource(CloudAudioSource.validate(id, track().getString("sourceUrl")));
            else player.setDataSource(cached.getAbsolutePath());
            player.setOnPreparedListener(media -> { if (media != player) return; prepared = true; if (remote && cloudPlayed.size() < 5000) { cloudPlayed.add(id); saveCloudPlayed(); } seek((long) (position * 1000)); if (wanted) play(); else refresh(); });
            player.setOnCompletionListener(media -> { if (!checkSleep(true)) advance(1, true); });
            player.setOnErrorListener((media, what, extra) -> { error = "此音频无法解码，请尝试 MP3 / WAV 或检查源文件"; wanted = false; prepared = false; refresh(); return true; });
            session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, track().optString("title")).putString(MediaMetadata.METADATA_KEY_ARTIST, track().optString("artist")).putString(MediaMetadata.METADATA_KEY_ALBUM, track().optString("album")).putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (track().optDouble("duration") * 1000)).build());
            player.prepareAsync(); refresh();
        } catch (Exception failure) { error = "后台播放失败：" + failure.getMessage(); wanted = false; refresh(); }
    }
    private void advance(int direction, boolean ended) {
        if (queue.length() == 0) return;
        if ("shuffle".equals(mode)) index = PlaybackRules.nextShuffle(queue.length(), index, shuffleBag, Math.random());
        else index = PlaybackRules.next(index, queue.length(), direction, mode, ended, Math.random());
        select(track().optString("id"), 0, true);
    }
    private boolean checkSleep(boolean ended) {
        if (PlaybackRules.sleepStop(deadline, System.currentTimeMillis(), finishTrack, ended, wanted)) { deadline = 0; pause(true); return true; }
        return false;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        try {
            if ("queue".equals(action)) {
                try (FileInputStream input = new FileInputStream(new File(getFilesDir(), "playback-queue.json")); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) { byte[] buffer = new byte[8192]; int length; while ((length = input.read(buffer)) != -1) bytes.write(buffer, 0, length); queue = new JSONArray(new String(bytes.toByteArray(), StandardCharsets.UTF_8)); }
                mode = intent.getStringExtra("mode"); volume = (float) intent.getDoubleExtra("volume", 0.7); fade = intent.getIntExtra("fade", 500);
                shuffleBag.clear();
                deadline = (long) intent.getDoubleExtra("deadline", 0); finishTrack = intent.getBooleanExtra("finishTrack", false);
                select(intent.getStringExtra("id"), intent.getDoubleExtra("position", 0), intent.getBooleanExtra("playing", true));
            } else if ("play".equals(action)) play();
            else if ("pause".equals(action)) pause(false);
            else if ("toggle".equals(action)) { if (wanted) pause(false); else play(); }
            else if ("next".equals(action)) advance(1, false);
            else if ("previous".equals(action)) advance(-1, false);
            else if ("select".equals(action)) select(intent.getStringExtra("text"), 0, true);
            else if ("seek".equals(action)) seek((long) (intent.getDoubleExtra("value", 0) * 1000));
            else if ("volume".equals(action)) { volume = (float) Math.max(0, Math.min(1, intent.getDoubleExtra("value", 0.7))); applyVolume(); }
            else if ("mode".equals(action)) { String value = intent.getStringExtra("text"); if ("list".equals(value) || "shuffle".equals(value) || "one".equals(value)) mode = value; }
            else if ("fade".equals(action)) fade = (int) Math.max(0, Math.min(2000, intent.getDoubleExtra("value", 500)));
            else if ("cached".equals(action)) { if (cloudPlayed.remove(intent.getStringExtra("text"))) saveCloudPlayed(); }
            else if ("sleep".equals(action)) { deadline = (long) intent.getDoubleExtra("value", 0); finishTrack = "finish-track".equals(intent.getStringExtra("text")); checkSleep(false); }
            else if ("stop".equals(action)) { pause(true); queue = new JSONArray(); refresh(); stopSelf(); }
            refresh();
        } catch (Exception failure) { error = failure.getMessage(); refresh(); }
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        instance = null; handler.removeCallbacksAndMessages(null); if (player != null) player.release();
        unregisterReceiver(noisyReceiver);
        if (session != null) { session.setActive(false); session.release(); }
        if (audioManager != null) { if (Build.VERSION.SDK_INT >= 26) audioManager.abandonAudioFocusRequest(focusRequest); else audioManager.abandonAudioFocus(focusListener); }
        sendBroadcast(new Intent(STATE_ACTION).setPackage(getPackageName()).putExtra("state", "{\"active\":false,\"playing\":false}")); super.onDestroy();
    }
}
