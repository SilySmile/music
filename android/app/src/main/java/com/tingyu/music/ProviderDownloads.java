package com.tingyu.music;

import android.content.Context;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

final class ProviderDownloads {
    private static final Map<String, HttpURLConnection> connections = new ConcurrentHashMap<>();
    private static final Map<String, File> files = new ConcurrentHashMap<>();
    private static final Map<String, long[]> states = new ConcurrentHashMap<>();
    static void cancel(String id) { HttpURLConnection connection = connections.remove(id); if (connection != null) connection.disconnect(); states.remove(id); }
    static JSONObject state(String id) throws Exception { long[] value = states.get(id); return new JSONObject().put("bytes", value == null ? 0 : value[0]).put("total", value == null ? 0 : value[1]); }
    static JSONObject download(Context context, String id, String provider, String url) throws Exception {
        if (!id.matches("[a-f0-9-]{36}") || files.containsKey(id) || states.putIfAbsent(id, new long[] {0, 0}) != null) throw new Exception("下载标识无效或已在下载");
        File directory = new File(context.getCacheDir(), "provider-downloads");
        File file = new File(directory, id + ".audio"); HttpURLConnection connection = null; boolean complete = false;
        try {
            if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法创建下载临时目录");
            String target = ProviderMedia.validate(provider, url);
            for (int redirect = 0; redirect <= 3; redirect++) {
                if (!states.containsKey(id)) throw new Exception("下载已取消");
                connection = (HttpURLConnection)new URL(target).openConnection(); connections.put(id, connection); connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false); connection.setRequestProperty("Accept-Encoding", "identity");
                if (!states.containsKey(id)) throw new Exception("下载已取消");
                int status = connection.getResponseCode(); if (status < 300 || status > 399) break;
                String next = connection.getHeaderField("Location"); connection.disconnect(); if (next == null || redirect == 3) throw new Exception("音频下载重定向异常"); target = ProviderMedia.validate(provider, new URL(new URL(target), next).toString());
            }
            if (connection.getResponseCode() != 200) throw new Exception("音频下载失败（HTTP " + connection.getResponseCode() + "）");
            long total = connection.getContentLengthLong(), bytes = 0; if (total > 200L * 1024 * 1024) throw new Exception("单首音频超过 200 MB"); String type = connection.getContentType();
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(file)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) { if (!states.containsKey(id) || Thread.currentThread().isInterrupted()) throw new Exception("下载已取消"); bytes += count; if (bytes > 200L * 1024 * 1024) throw new Exception("单首音频超过 200 MB"); output.write(buffer, 0, count); if (states.replace(id, new long[] {bytes, Math.max(0, total)}) == null) throw new Exception("下载已取消"); }
                output.getFD().sync();
            }
            if (!states.containsKey(id)) throw new Exception("下载已取消");
            if (bytes == 0 || (total > 0 && bytes != total)) throw new Exception("音频下载不完整，未加入音乐库");
            files.put(id, file); complete = true; return new JSONObject().put("token", id).put("size", bytes).put("type", type == null ? "application/octet-stream" : type);
        } finally { connections.remove(id); if (connection != null) connection.disconnect(); if (!complete) { file.delete(); states.remove(id); } }
    }
    static JSONObject read(String token, long offset, int length) throws Exception {
        File file = files.get(token); if (file == null || offset < 0 || length < 1 || length > 1024 * 1024 || offset + length > file.length()) throw new Exception("下载读取范围无效");
        byte[] bytes = new byte[length]; try (RandomAccessFile input = new RandomAccessFile(file, "r")) { input.seek(offset); input.readFully(bytes); }
        return new JSONObject().put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
    }
    static void remove(String token) throws Exception { File file = files.get(token); if (file != null) { if (file.exists() && !file.delete()) throw new Exception("临时音频清理失败"); files.remove(token); states.remove(token); } }
}
