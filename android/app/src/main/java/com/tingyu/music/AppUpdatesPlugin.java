package com.tingyu.music;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.AtomicFile;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

@CapacitorPlugin(name = "AppUpdates")
public class AppUpdatesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean canceled = new AtomicBoolean(false);
    private volatile HttpsURLConnection connection;
    private JSONObject state = new JSONObject();
    private JSONObject settings;
    private JSONObject trust;

    @Override public void load() {
        try {
            trust = new JSONObject(read(getContext().getAssets().open("update-public.json"), 65536));
            state.put("phase", "idle"); state.put("currentVersion", version()); state.put("platform", "android"); state.put("bytes", 0); state.put("total", 0); state.put("message", "");
        } catch (Exception error) { try { state.put("phase", "error"); state.put("message", "更新信任配置读取失败"); } catch (Exception ignored) {} }
    }
    @Override protected void handleOnDestroy() { canceled.set(true); if (connection != null) connection.disconnect(); worker.shutdownNow(); }
    private String version() throws Exception { return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; }
    private File directory() throws Exception { File directory = new File(getContext().getFilesDir(), "updates"); if (!directory.exists() && !directory.mkdirs()) throw new Exception("无法创建更新目录"); return directory; }
    private File configFile() throws Exception { File directory = new File(getContext().getFilesDir(), "config"); if (!directory.exists() && !directory.mkdirs()) throw new Exception("无法创建配置目录"); return new File(directory, "update-settings.json"); }
    private static String read(InputStream stream, int limit) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int length;
            while ((length = input.read(buffer)) != -1) { if (output.size() + length > limit) throw new Exception("更新清单过大"); output.write(buffer, 0, length); }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }
    private static void atomic(File file, JSONObject contents) throws Exception {
        AtomicFile atomic = new AtomicFile(file); FileOutputStream output = null;
        try { output = atomic.startWrite(); output.write(contents.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(output); }
        catch (Exception error) { if (output != null) atomic.failWrite(output); throw error; }
    }
    private synchronized JSONObject configValue() throws Exception {
        if (settings == null) {
            settings = new JSONObject(); settings.put("baseUrl", trust.getString("defaultBaseUrl")); settings.put("autoCheck", false); settings.put("lastChecked", 0); settings.put("highestVersion", version());
            try {
                JSONObject saved = new JSONObject(read(new FileInputStream(configFile()), 65536));
                settings.put("baseUrl", UpdateRules.baseUrl(saved.getString("baseUrl"))); settings.put("autoCheck", saved.optBoolean("autoCheck", false)); settings.put("lastChecked", saved.optLong("lastChecked", 0));
                if (UpdateRules.compare(saved.optString("highestVersion", version()), version()) > 0) settings.put("highestVersion", saved.getString("highestVersion"));
            } catch (Exception ignored) {}
        }
        JSONObject result = new JSONObject(settings.toString()); result.put("currentVersion", version()); result.put("platform", "android"); result.put("configPath", configFile().getAbsolutePath()); result.put("downloadDirectory", directory().getAbsolutePath()); return result;
    }
    private synchronized JSObject snapshot() throws Exception { return new JSObject(state.toString()); }
    private synchronized void emit(String phase, String message, long bytes, long total) throws Exception {
        if (phase != null) state.put("phase", phase); if (message != null) state.put("message", message); if (bytes >= 0) state.put("bytes", bytes); if (total >= 0) state.put("total", total);
        notifyListeners("state", snapshot());
    }
    private HttpsURLConnection open(String url, long offset) throws Exception {
        HttpsURLConnection request = (HttpsURLConnection) new URL(url).openConnection(); request.setInstanceFollowRedirects(false); request.setConnectTimeout(20000); request.setReadTimeout(20000); request.setUseCaches(false); request.setRequestProperty("Accept-Encoding", "identity"); if (offset > 0) request.setRequestProperty("Range", "bytes=" + offset + "-");
        connection = request; int status = request.getResponseCode(); if (status >= 300 && status < 400) { request.disconnect(); throw new Exception("服务器发生重定向，请填写最终 HTTPS 地址"); } return request;
    }
    private static long date(String value) throws Exception { SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US); format.setTimeZone(TimeZone.getTimeZone("UTC")); format.setLenient(false); return format.parse(value).getTime(); }
    private JSONObject verify(String text) throws Exception {
        if (text.getBytes(StandardCharsets.UTF_8).length > 262144) throw new Exception("更新清单过大");
        JSONObject envelope = new JSONObject(text); if (!"RSA-SHA256".equals(envelope.optString("algorithm"))) throw new Exception("更新签名格式无效");
        String pem = trust.getString("publicKey").replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replaceAll("\\s", "");
        byte[] payload = Base64.decode(envelope.getString("payload"), Base64.DEFAULT);
        if (!UpdateRules.verify(Base64.decode(pem, Base64.DEFAULT), payload, Base64.decode(envelope.getString("signature"), Base64.DEFAULT))) throw new Exception("更新清单签名失败，拒绝下载或安装");
        JSONObject result = new JSONObject(new String(payload, StandardCharsets.UTF_8)); UpdateRules.compare(result.getString("version"), result.getString("version"));
        long issued = date(result.getString("issuedAt")); long expires = date(result.getString("expiresAt")); long now = System.currentTimeMillis();
        if (!"xianqiji".equals(result.optString("product")) || result.optInt("schema") != 1 || issued > now + 86400000L || expires <= now || expires <= issued || expires - issued > 366L * 86400000L || result.getString("notes").length() > 12000) throw new Exception("清单不适用、已过期或设备时间不正确");
        JSONObject artifact = result.getJSONObject("artifacts").getJSONObject("android");
        if (!"apk".equals(artifact.getString("kind")) || !artifact.getString("sha256").matches("[a-f0-9]{64}") || artifact.getLong("size") <= 0 || artifact.getLong("size") > 4L * 1024 * 1024 * 1024) throw new Exception("安卓安装包信息无效");
        UpdateRules.artifactUrl(configValue().getString("baseUrl"), artifact.getString("file"), result.getString("version")); return result;
    }
    private JSONObject release() throws Exception {
        JSONObject saved = new JSONObject(read(new FileInputStream(new File(directory(), "checked-release.json")), 262144));
        if (!saved.getString("baseUrl").equals(configValue().getString("baseUrl"))) throw new Exception("地址已修改，请重新检查更新");
        JSONObject release = verify(saved.getString("envelope"));
        if (UpdateRules.compare(release.getString("version"), settings.getString("highestVersion")) < 0 || UpdateRules.compare(release.getString("version"), version()) <= 0) throw new Exception("拒绝安装旧版本，请重新检查更新"); return release;
    }
    private File target(JSONObject artifact, boolean partial) throws Exception { return new File(directory(), artifact.getString("sha256") + ".apk" + (partial ? ".part" : "")); }
    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[1024 * 1024];
        try (InputStream input = new FileInputStream(file)) { int length; while ((length = input.read(buffer)) != -1) digest.update(buffer, 0, length); }
        StringBuilder result = new StringBuilder(); for (byte value : digest.digest()) result.append(String.format("%02x", value & 0xff)); return result.toString();
    }
    private void releaseState(JSONObject release, JSONObject artifact) throws Exception { JSONObject visible = new JSONObject(); visible.put("version", release.getString("version")); visible.put("notes", release.getString("notes")); visible.put("issuedAt", release.getString("issuedAt")); visible.put("size", artifact.getLong("size")); visible.put("kind", "apk"); synchronized (this) { state.put("release", visible); } }
    @PluginMethod public void config(PluginCall call) { try { call.resolve(new JSObject(configValue().toString())); } catch (Exception error) { call.reject(error.getMessage()); } }
    @PluginMethod public void state(PluginCall call) { try { call.resolve(snapshot()); } catch (Exception error) { call.reject(error.getMessage()); } }
    @PluginMethod public void saveConfig(PluginCall call) {
        try {
            if (running.get()) throw new Exception("请先暂停下载或等待检查结束"); configValue();
            JSONObject next = new JSONObject(settings.toString()); next.put("baseUrl", UpdateRules.baseUrl(call.getString("baseUrl"))); next.put("autoCheck", call.getBoolean("autoCheck", false)); atomic(configFile(), next); settings = next;
            new File(directory(), "checked-release.json").delete(); synchronized (this) { state.remove("release"); } emit("idle", "更新地址已保存", 0, 0); call.resolve(new JSObject(configValue().toString()));
        } catch (Exception error) { call.reject(error.getMessage()); }
    }
    @PluginMethod public void check(PluginCall call) {
        if (!running.compareAndSet(false, true)) { call.reject("另一个更新操作正在进行"); return; }
        worker.execute(() -> {
            try {
                configValue(); emit("checking", "正在验证更新清单…", -1, -1); settings.put("lastChecked", System.currentTimeMillis()); atomic(configFile(), settings);
                HttpsURLConnection response = open(settings.getString("baseUrl") + "manifest.json", 0); if (response.getResponseCode() != 200) throw new Exception("更新服务不可用（HTTP " + response.getResponseCode() + "）");
                String envelope = read(response.getInputStream(), 262144); response.disconnect(); JSONObject release = verify(envelope);
                if (UpdateRules.compare(release.getString("version"), settings.getString("highestVersion")) < 0 && UpdateRules.compare(release.getString("version"), version()) > 0) throw new Exception("更新清单版本倒退，已拒绝");
                if (UpdateRules.compare(release.getString("version"), settings.getString("highestVersion")) > 0) settings.put("highestVersion", release.getString("version")); atomic(configFile(), settings);
                if (UpdateRules.compare(release.getString("version"), version()) <= 0) { synchronized (this) { state.remove("release"); } emit("up-to-date", "当前已是最新版本", 0, 0); }
                else {
                    JSONObject saved = new JSONObject(); saved.put("baseUrl", settings.getString("baseUrl")); saved.put("envelope", envelope); atomic(new File(directory(), "checked-release.json"), saved);
                    JSONObject artifact = release.getJSONObject("artifacts").getJSONObject("android"); releaseState(release, artifact); File complete = target(artifact, false); long size = artifact.getLong("size"); boolean valid = complete.length() == size && sha256(complete).equals(artifact.getString("sha256"));
                    emit(valid ? "downloaded" : "available", valid ? "安装包已校验，可安装" : "发现新版本，可下载或继续", valid ? size : Math.min(size, target(artifact, true).length()), size);
                }
                call.resolve(snapshot());
            } catch (Exception error) { try { emit("error", error.getMessage(), -1, -1); call.resolve(snapshot()); } catch (Exception failure) { call.reject(failure.getMessage()); } }
            finally { if (connection != null) connection.disconnect(); connection = null; running.set(false); }
        });
    }
    @PluginMethod public void pause(PluginCall call) { canceled.set(true); if (connection != null) connection.disconnect(); try { call.resolve(snapshot()); } catch (Exception error) { call.reject(error.getMessage()); } }
    @PluginMethod public void download(PluginCall call) {
        if (!running.compareAndSet(false, true)) { call.reject("另一个更新操作正在进行"); return; } canceled.set(false);
        worker.execute(() -> {
            try {
                JSONObject release = release(); JSONObject artifact = release.getJSONObject("artifacts").getJSONObject("android"); releaseState(release, artifact); long size = artifact.getLong("size"); File partial = target(artifact, true); long offset = partial.length();
                if (offset > size) { try (RandomAccessFile output = new RandomAccessFile(partial, "rw")) { output.setLength(0); } offset = 0; }
                emit("downloading", "正在下载并保存进度…", offset, size);
                if (offset < size) {
                    HttpsURLConnection response = open(UpdateRules.artifactUrl(settings.getString("baseUrl"), artifact.getString("file"), release.getString("version")), offset); int status = response.getResponseCode(); if (status != 200 && status != 206) throw new Exception("下载失败（HTTP " + status + "）");
                    if (status == 200 && offset > 0) { try (RandomAccessFile output = new RandomAccessFile(partial, "rw")) { output.setLength(0); } offset = 0; }
                    if (status == 206 && !("bytes " + offset + "-" + (size - 1) + "/" + size).equals(response.getHeaderField("Content-Range"))) throw new Exception("续传范围不一致，未追加文件");
                    try (InputStream input = response.getInputStream(); RandomAccessFile output = new RandomAccessFile(partial, "rw")) {
                        output.seek(offset); byte[] buffer = new byte[256 * 1024]; int length; long synced = offset; long emitted = 0;
                        try {
                            while ((length = input.read(buffer)) != -1) { if (canceled.get()) throw new Exception("已暂停"); if (offset + length > size) throw new Exception("安装包超过声明大小"); output.write(buffer, 0, length); offset += length; if (offset - synced >= 4 * 1024 * 1024) { output.getFD().sync(); synced = offset; } if (System.currentTimeMillis() - emitted > 250) { emitted = System.currentTimeMillis(); emit(null, null, offset, size); } }
                        } finally { output.getFD().sync(); }
                    }
                    response.disconnect();
                }
                if (canceled.get()) throw new Exception("已暂停");
                if (partial.length() != size) throw new Exception("下载尚未完整，进度已保存，可继续");
                if (!sha256(partial).equals(artifact.getString("sha256"))) { partial.delete(); throw new Exception("安装包完整性校验失败，不可信文件已移除"); }
                if (!partial.renameTo(target(artifact, false))) throw new Exception("安装包保存失败"); emit("downloaded", "下载完成，签名与 SHA-256 校验通过，尚未安装", size, size); call.resolve(snapshot());
            } catch (Exception error) { try { emit(canceled.get() ? "paused" : "error", canceled.get() ? "下载已暂停，可继续" : error.getMessage(), -1, -1); call.resolve(snapshot()); } catch (Exception failure) { call.reject(failure.getMessage()); } }
            finally { if (connection != null) connection.disconnect(); connection = null; running.set(false); }
        });
    }
    @PluginMethod public void install(PluginCall call) {
        if (!running.compareAndSet(false, true)) { call.reject("请先等待下载完成"); return; }
        worker.execute(() -> {
            try {
                JSONObject release = release(); JSONObject artifact = release.getJSONObject("artifacts").getJSONObject("android"); File file = target(artifact, false);
                if (file.length() != artifact.getLong("size") || !sha256(file).equals(artifact.getString("sha256"))) throw new Exception("安装包已改变，拒绝安装");
                PackageManager manager = getContext().getPackageManager(); int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
                PackageInfo update = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags); PackageInfo current = manager.getPackageInfo(getContext().getPackageName(), flags);
                if (update == null || !getContext().getPackageName().equals(update.packageName) || !release.getString("version").equals(update.versionName) || (Build.VERSION.SDK_INT >= 28 ? update.getLongVersionCode() <= current.getLongVersionCode() : update.versionCode <= current.versionCode)) throw new Exception("APK 包名或版本不符，拒绝安装");
                android.content.pm.Signature[] updateSigners = Build.VERSION.SDK_INT >= 28 ? update.signingInfo.getApkContentsSigners() : update.signatures;
                android.content.pm.Signature[] currentSigners = Build.VERSION.SDK_INT >= 28 ? current.signingInfo.getApkContentsSigners() : current.signatures;
                if (updateSigners == null || currentSigners == null || updateSigners.length != currentSigners.length || updateSigners.length == 0) throw new Exception("APK 签名信息不可用");
                java.util.Set<String> expected = new java.util.HashSet<>(); for (android.content.pm.Signature signer : currentSigners) expected.add(Base64.encodeToString(signer.toByteArray(), Base64.NO_WRAP));
                for (android.content.pm.Signature signer : updateSigners) if (!expected.contains(Base64.encodeToString(signer.toByteArray(), Base64.NO_WRAP))) throw new Exception("APK 签名与当前应用不一致，拒绝安装");
                getBridge().executeOnMainThread(() -> {
                    try {
                        JSObject result = new JSObject();
                        if (Build.VERSION.SDK_INT >= 26 && !manager.canRequestPackageInstalls()) { getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))); result.put("permissionNeeded", true); }
                        else { Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file); Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); getActivity().startActivity(intent); result.put("installed", true); }
                        call.resolve(result);
                    } catch (Exception error) { call.reject(error.getMessage()); }
                    finally { running.set(false); }
                });
            } catch (Exception error) { running.set(false); call.reject(error.getMessage()); }
        });
    }
}
