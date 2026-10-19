package com.tingyu.music;

import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class SourceDownloadWorker {
    interface Transport { JSONObject record(String identifier) throws Exception; byte[] chunk(String identifier, String kind, JSONObject media, long offset, int length) throws Exception; }
    interface Destination { String begin(JSONObject remote) throws Exception; boolean needs(String upload, String kind) throws Exception; void write(String upload, String kind, long offset, byte[] bytes) throws Exception; void finish(String upload, JSONObject hashes) throws Exception; void cancel(String upload) throws Exception; }
    interface Control { void check() throws Exception; boolean paused(); }
    interface Journal { void save(JSONObject task) throws Exception; }
    interface Progress { void update(String message) throws Exception; }
    static JSONObject run(JSONObject task, Transport transport, Destination destination, Control control, Journal journal, Progress progress) throws Exception {
        JSONArray identifiers = task.getJSONArray("ids"); Set<String> completed = new HashSet<>(); JSONArray saved = task.getJSONArray("completed");
        for (int index = 0; index < saved.length(); index++) completed.add(saved.getString(index));
        task.put("status", "running"); task.remove("error");
        try {
            journal.save(task);
            for (int index = 0; index < identifiers.length(); index++) {
                String identifier = identifiers.getString(index); if (completed.contains(identifier)) continue;
                control.check(); JSONObject remote = transport.record(identifier); SourceDownloadRules.validate(remote, identifier); control.check();
                String upload = destination.begin(remote); boolean committed = false;
                try {
                    JSONObject hashes = new JSONObject();
                    for (String kind : new String[] { "audio", "cover" }) {
                        if (!destination.needs(upload, kind)) continue;
                        JSONObject media = remote.getJSONObject(kind); long size = SafeNumbers.fileOffset(media.get("size")); MessageDigest digest = MessageDigest.getInstance("SHA-256");
                        for (long offset = 0; offset < size; offset += 1024 * 1024) {
                            control.check(); progress.update("原生后台下载 · " + completed.size() + " / " + identifiers.length() + " 首 · " + remote.getJSONObject("metadata").getString("title") + " · " + (offset * 100 / size) + "%");
                            int length = (int) Math.min(1024 * 1024, size - offset); byte[] bytes = transport.chunk(identifier, kind, media, offset, length); control.check();
                            if (bytes.length != length) throw new Exception("云端分块不完整，未加入本地库");
                            digest.update(bytes); destination.write(upload, kind, offset, bytes);
                        }
                        String hash = SourceDownloadRules.hex(digest.digest()); if (!hash.equals(media.getString("sha256"))) throw new Exception("云端文件 SHA-256 不符，未加入本地库"); hashes.put(kind, hash);
                    }
                    control.check(); destination.finish(upload, hashes); committed = true;
                    completed.add(identifier); task.getJSONArray("completed").put(identifier); journal.save(task);
                    progress.update("原生后台已写入当前音乐库 · " + completed.size() + " / " + identifiers.length() + " 首");
                } finally { if (!committed) destination.cancel(upload); }
            }
            task.put("status", "completed");
        } catch (Exception error) { task.put("status", control.paused() ? "paused" : "failed"); if (!control.paused()) task.put("error", error.getMessage() == null ? "下载未完成，请核对后继续" : error.getMessage()); }
        finally { task.put("updatedAt", System.currentTimeMillis()); journal.save(task); }
        return task;
    }
}
