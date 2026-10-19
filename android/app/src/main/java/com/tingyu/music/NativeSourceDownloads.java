package com.tingyu.music;

import android.content.Context;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

final class NativeSourceDownloads {
    interface Completion { void complete(JSONObject task); void failed(String message); }
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static final ConcurrentHashMap<String, Operation> active = new ConcurrentHashMap<>();
    private static final Object journalLock = new Object();
    private static final class Operation implements SourceDownloadWorker.Control {
        final AtomicBoolean cancelled = new AtomicBoolean();
        volatile HttpURLConnection connection;
        volatile Thread thread;
        volatile JSONObject snapshot;
        void pause() { cancelled.set(true); HttpURLConnection current = connection; if (current != null) current.disconnect(); Thread running = thread; if (running != null) running.interrupt(); }
        @Override public void check() throws Exception { if (paused()) throw new Exception("已暂停，已完成歌曲保留"); }
        @Override public boolean paused() { return cancelled.get() || Thread.currentThread().isInterrupted(); }
    }
    static boolean running(String identifier) { return active.containsKey(identifier); }
    static void pause(String identifier) { Operation operation = active.get(identifier); if (operation != null) operation.pause(); }
    static void pauseAll() { for (Operation operation : active.values()) operation.pause(); }
    private static AtomicFile file(Context context, String identifier) throws Exception {
        if (!identifier.matches("[a-zA-Z0-9-]{1,80}")) throw new Exception("下载任务标识无效");
        File directory = new File(context.getNoBackupFilesDir(), "source-download-tasks");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法保存下载检查点，请检查空间");
        return new AtomicFile(new File(directory, identifier + ".json"));
    }
    static JSONObject clean(JSONObject supplied) throws Exception {
        JSONObject task = new JSONObject(); String identifier = supplied.getString("id");
        if (!identifier.matches("[a-zA-Z0-9-]{1,80}") || !"source".equals(supplied.getString("kind")) || !"download".equals(supplied.getString("direction")) || !supplied.getString("sourceIdentity").matches("[a-f0-9]{64}") || !supplied.getString("scope").startsWith("folder:")) throw new Exception("原生下载任务无效，请重新选择歌曲");
        for (String key : new String[] { "id", "kind", "direction", "label", "sourceIdentity", "scope" }) task.put(key, supplied.getString(key));
        if (supplied.has("libraryKey")) task.put("libraryKey", supplied.getString("libraryKey"));
        JSONArray identifiers = supplied.getJSONArray("ids"); Set<String> wanted = new HashSet<>();
        if (identifiers.length() == 0 || identifiers.length() > 100000) throw new Exception("下载歌曲清单无效");
        for (int index = 0; index < identifiers.length(); index++) if (!identifiers.getString(index).matches("[a-f0-9]{64}") || !wanted.add(identifiers.getString(index))) throw new Exception("下载歌曲清单无效");
        JSONArray completed = new JSONArray(); JSONArray provided = supplied.getJSONArray("completed"); Set<String> seen = new HashSet<>();
        for (int index = 0; index < provided.length(); index++) { String value = provided.getString(index); if (!wanted.contains(value) || !seen.add(value)) throw new Exception("下载检查点不属于当前歌曲清单"); completed.put(value); }
        task.put("ids", new JSONArray(identifiers.toString())); task.put("completed", completed); task.put("status", "paused"); task.put("updatedAt", System.currentTimeMillis()); task.put("nativeDownload", true); return task;
    }
    private static void save(Context context, JSONObject task, Operation operation) throws Exception {
        task.put("updatedAt", System.currentTimeMillis()); byte[] bytes = task.toString().getBytes(StandardCharsets.UTF_8);
        synchronized (journalLock) {
            AtomicFile destination = file(context, task.getString("id")); FileOutputStream output = null;
            try { output = destination.startWrite(); output.write(bytes); destination.finishWrite(output); }
            catch (Exception error) { if (output != null) destination.failWrite(output); throw error; }
        }
        operation.snapshot = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }
    static JSONArray states(Context context) throws Exception {
        JSONArray result = new JSONArray(); File directory = new File(context.getNoBackupFilesDir(), "source-download-tasks"); File[] files = directory.listFiles((parent, name) -> name.matches("[a-zA-Z0-9-]{1,80}\\.json"));
        if (files == null) return result;
        for (File entry : files) {
            try {
                JSONObject task;
                synchronized (journalLock) { if (entry.length() > 32 * 1024 * 1024) continue; task = new JSONObject(new String(new AtomicFile(entry).readFully(), StandardCharsets.UTF_8)); }
                Operation operation = active.get(task.getString("id")); if (operation != null && operation.snapshot != null) task = new JSONObject(operation.snapshot.toString());
                if (operation == null && "running".equals(task.optString("status"))) { task.put("status", "paused"); task.put("progress", "上次原生下载已中断，已完成歌曲保留，请手动继续"); }
                result.put(task);
            } catch (Exception ignored) {}
        }
        return result;
    }
    static void forget(Context context, String identifier) throws Exception { if (active.containsKey(identifier)) throw new Exception("请先暂停下载再移除记录"); synchronized (journalLock) { file(context, identifier).delete(); } }
    private static JSONObject request(String base, String token, String route, Operation operation) throws Exception {
        operation.check(); HttpURLConnection connection = (HttpURLConnection) new URI(base).resolve(route).toURL().openConnection(); operation.connection = connection;
        try {
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(120000); connection.setRequestProperty("Accept", "application/json"); if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
            operation.check(); int status = connection.getResponseCode(); if (status != 200) throw new Exception(status == 401 || status == 403 ? "曲库读取权限失效，请核对后继续" : "曲库下载请求失败（HTTP " + status + "），已完成歌曲保留");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[32768]; int length;
                while ((length = input.read(buffer)) != -1) { operation.check(); if (output.size() + length > 8 * 1024 * 1024) throw new Exception("曲库响应超过安全读取范围"); output.write(buffer, 0, length); }
                return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { operation.connection = null; connection.disconnect(); }
    }
    static void start(Context context, JSONObject supplied, String baseValue, String token, Completion callback) {
        Operation operation = new Operation(); String identifier;
        try {
            JSONObject task = clean(supplied); identifier = task.getString("id"); String base = SourceDownloadRules.baseUrl(baseValue);
            if (token.length() > 8192 || token.contains("\r") || token.contains("\n") || !SourceDownloadRules.identity(baseValue, token).equals(task.getString("sourceIdentity"))) throw new Exception("音源地址或密钥与任务不符，请恢复原连接");
            DocumentLibraryPlugin library = DocumentLibraryPlugin.current(); library.checkSourceScope(task.getString("scope"));
            AtomicFile checkpoint = file(context, identifier);
            if (active.putIfAbsent(identifier, operation) != null) throw new Exception("此下载已由原生服务运行，请到任务中心查看");
            try {
                synchronized (journalLock) {
                    if (checkpoint.getBaseFile().exists() || new File(checkpoint.getBaseFile() + ".bak").exists()) {
                        JSONObject previous = clean(new JSONObject(new String(checkpoint.readFully(), StandardCharsets.UTF_8)));
                        if (!previous.getString("sourceIdentity").equals(task.getString("sourceIdentity")) || !previous.getString("scope").equals(task.getString("scope")) || !previous.getJSONArray("ids").toString().equals(task.getJSONArray("ids").toString())) throw new Exception("原生下载检查点属于不同的曲库或歌曲清单");
                        Set<String> completed = new HashSet<>(); JSONArray merged = task.getJSONArray("completed"); for (int index = 0; index < merged.length(); index++) completed.add(merged.getString(index));
                        JSONArray old = previous.getJSONArray("completed"); for (int index = 0; index < old.length(); index++) if (completed.add(old.getString(index))) merged.put(old.getString(index));
                    }
                }
                task.put("status", "running"); save(context, task, operation);
            } catch (Exception error) { active.remove(identifier, operation); throw error; }
            worker.execute(() -> {
                operation.thread = Thread.currentThread(); String scope = task.optString("scope"); final long[] lastNotification = { 0 };
                try {
                    SourceDownloadWorker.Transport transport = new SourceDownloadWorker.Transport() {
                        @Override public JSONObject record(String song) throws Exception { return request(base, token, "tracks/" + song, operation); }
                        @Override public byte[] chunk(String song, String kind, JSONObject media, long offset, int length) throws Exception {
                            JSONObject response = request(base, token, "tracks/" + song + "/media/" + kind + "?offset=" + offset + "&length=" + length, operation);
                            if (!response.getString("sha256").equals(media.getString("sha256")) || SafeNumbers.fileOffset(response.opt("size")) != media.getLong("size") || SafeNumbers.fileOffset(response.opt("offset")) != offset || response.getString("data").length() > 2 * 1024 * 1024) throw new Exception("云端分块版本已改变，原本地歌曲保留");
                            return Base64.decode(response.getString("data"), Base64.DEFAULT);
                        }
                    };
                    SourceDownloadWorker.Destination destination = new SourceDownloadWorker.Destination() {
                        @Override public String begin(JSONObject remote) throws Exception { return library.beginSourceDownload(scope, remote); }
                        @Override public boolean needs(String upload, String kind) throws Exception { return library.needsSourceMedia(upload, kind); }
                        @Override public void write(String upload, String kind, long offset, byte[] bytes) throws Exception { library.writeSourceDownload(scope, upload, kind, offset, bytes); }
                        @Override public void finish(String upload, JSONObject hashes) throws Exception { library.finishSourceDownload(scope, upload, hashes); }
                        @Override public void cancel(String upload) throws Exception { boolean interrupted = Thread.interrupted(); try { library.cancelSourceDownload(upload); } finally { if (interrupted) Thread.currentThread().interrupt(); } }
                    };
                    JSONObject result = SourceDownloadWorker.run(task, transport, destination, operation, (value) -> save(context, value, operation), (message) -> {
                        task.put("progress", message);
                        if (System.currentTimeMillis() - lastNotification[0] >= 750) { lastNotification[0] = System.currentTimeMillis(); operation.snapshot = new JSONObject(task.toString()); BackgroundTaskService.update(identifier, message); BackgroundTasksPlugin.downloadProgress(task); }
                    });
                    callback.complete(result);
                } catch (Exception error) {
                    try { task.put("status", operation.paused() ? "paused" : "failed"); if (!operation.paused()) task.put("error", "原生下载未完成，请检查空间、网络或目录授权后继续"); save(context, task, operation); callback.complete(task); }
                    catch (Exception failure) { callback.failed("原生下载检查点保存失败，已保存到音乐库的歌曲保留，请检查空间"); }
                } finally { operation.thread = null; active.remove(identifier, operation); BackgroundTaskService.finish(identifier); Thread.interrupted(); }
            });
        } catch (Exception error) { callback.failed(error.getMessage() == null ? "原生下载未启动" : error.getMessage()); }
    }
}
