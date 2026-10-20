package com.tingyu.music;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.AtomicFile;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "DocumentLibrary")
public class DocumentLibraryPlugin extends Plugin {
    private static volatile DocumentLibraryPlugin instance;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean selecting = new AtomicBoolean(false);
    private final Map<String, LibraryDocuments.Node> candidates = new HashMap<>();
    private final Map<String, Upload> uploads = new HashMap<>();
    private LibraryDocuments documents;
    private interface Operation { JSObject run() throws Exception; }
    private static final class Upload {
        LibraryDocuments.Node root;
        LibraryDocuments.Node directory;
        JSONObject metadata;
        JSONObject record;
        JSONObject source;
        JSONObject original;
        String scope;
        Map<String, Long> offsets = new HashMap<>();
    }

    @Override public void load() { documents = new LibraryDocuments(getContext().getContentResolver()); instance = this; }
    @Override protected void handleOnDestroy() { NativeSourceDownloads.pauseAll(); if (instance == this) instance = null; worker.shutdownNow(); }
    static DocumentLibraryPlugin current() throws Exception { DocumentLibraryPlugin current = instance; if (current == null) throw new Exception("音乐库服务未就绪，请重新打开应用"); return current; }
    private <Result> Result nativeOperation(Callable<Result> operation) throws Exception {
        try { return worker.submit(() -> { documents.reset(); return operation.call(); }).get(); }
        catch (ExecutionException error) { if (error.getCause() instanceof Exception) throw (Exception) error.getCause(); throw new Exception("音乐库操作失败，原曲库保留"); }
    }
    private LibraryDocuments.Node sourceRoot(String scope) throws Exception {
        LibraryDocuments.Node selected = root(null); JSONObject index = index(selected);
        if (!scope.equals("folder:" + index.getString("libraryId"))) throw new Exception("下载任务属于另一音乐库，请切回原库继续");
        return selected;
    }
    void checkSourceScope(String scope) throws Exception { nativeOperation(() -> { sourceRoot(scope); return null; }); }
    String beginSourceDownload(String scope, JSONObject source) throws Exception {
        return nativeOperation(() -> {
            Upload upload = new Upload(); upload.root = sourceRoot(scope); upload.scope = scope; upload.source = new JSONObject(source.toString()); String identifier = source.getJSONObject("metadata").getString("id");
            JSONObject existing = index(upload.root).getJSONObject("tracks").optJSONObject(identifier);
            if (existing != null) { if (!identifier.equals(existing.getJSONObject("metadata").getString("id")) || !identifier.equals(existing.getJSONObject("audio").getString("sha256"))) throw new Exception("现有歌曲标识或指纹已改变，原库保留"); media(upload.root, existing, "audio"); if (existing.has("cover")) media(upload.root, existing, "cover"); upload.original = new JSONObject(existing.toString()); }
            upload.metadata = existing == null ? metadata(source.getJSONObject("metadata")) : SourceDownloadRules.supplement(existing.getJSONObject("metadata"), source.getJSONObject("metadata"));
            if (existing == null) { upload.metadata.put("favorite", source.getJSONObject("metadata").optBoolean("favorite")); upload.metadata.put("addedAt", System.currentTimeMillis()); }
            upload.record = existing == null ? new JSONObject().put("metadata", upload.metadata) : new JSONObject(existing.toString()).put("metadata", upload.metadata);
            upload.directory = upload.root.folder("歌曲").folder(identifier); String token = UUID.randomUUID().toString(); uploads.put(token, upload);
            try {
                String base = LibraryPaths.safeName(upload.metadata.getString("artist") + " - " + upload.metadata.getString("title"));
                for (String kind : new String[] { "audio", "cover" }) {
                    if (upload.record.has(kind) || !source.has(kind)) continue;
                    JSONObject file = descriptor(source.getJSONObject(kind)); String format = upload.metadata.optString("format", "mp3"); if (!format.matches("[a-zA-Z0-9]{2,5}")) format = "mp3";
                    String extension = kind.equals("audio") ? format : file.getString("type").equals("image/png") ? "png" : file.getString("type").equals("image/webp") ? "webp" : "jpg";
                    String filename = (kind.equals("audio") ? base : "cover") + "-" + token + "." + extension;
                    LibraryDocuments.Node created = upload.directory.create(filename, "application/octet-stream"); file.put("file", filename); if (kind.equals("audio")) file.put("uri", created.uri.toString()); upload.record.put(kind, file); upload.offsets.put(kind, 0L);
                }
                return token;
            } catch (Exception error) { cancelSourceValue(token); throw error; }
        });
    }
    boolean needsSourceMedia(String token, String kind) throws Exception { return nativeOperation(() -> { Upload upload = uploads.get(token); if (upload == null || upload.source == null) throw new Exception("下载写入任务已失效"); return upload.offsets.containsKey(kind); }); }
    void writeSourceDownload(String scope, String token, String kind, long offset, byte[] bytes) throws Exception {
        nativeOperation(() -> {
            Upload upload = uploads.get(token);
            if (upload == null || upload.source == null || !scope.equals(upload.scope) || !config().optString("uri").equals(upload.root.uri.toString()) || !upload.offsets.containsKey(kind) || bytes.length > 1024 * 1024 || offset != upload.offsets.get(kind) || offset + bytes.length > upload.record.getJSONObject(kind).getLong("size")) throw new Exception("下载分块位置或音乐库已变化");
            upload.directory.required(upload.record.getJSONObject(kind).getString("file")).write(offset, bytes); upload.offsets.put(kind, offset + bytes.length); return null;
        });
    }
    void finishSourceDownload(String scope, String token, JSONObject hashes) throws Exception {
        nativeOperation(() -> {
            sourceRoot(scope); Upload upload = uploads.get(token); if (upload == null || upload.source == null || !scope.equals(upload.scope) || !config().optString("uri").equals(upload.root.uri.toString())) throw new Exception("下载写入任务或音乐库已变化");
            for (String kind : upload.offsets.keySet()) {
                JSONObject file = upload.record.getJSONObject(kind); LibraryDocuments.Node node = upload.directory.required(file.getString("file")); String hash = hashes.getString(kind);
                // The native worker already hashed every received chunk against the server digest; reading
                // the whole file back through SAF again doubled the I/O without adding information.
                if (!hash.equals(upload.source.getJSONObject(kind).getString("sha256")) || upload.offsets.get(kind) != file.getLong("size") || node.size != file.getLong("size")) throw new Exception("下载文件不完整或校验失败，原库保留");
                file.put("sha256", hash);
            }
            JSONObject index = index(upload.root); String identifier = upload.metadata.getString("id"); JSONObject latest = index.getJSONObject("tracks").optJSONObject(identifier);
            if (upload.original == null && latest != null || upload.original != null && (latest == null || !latest.getJSONObject("audio").toString().equals(upload.original.getJSONObject("audio").toString()))) throw new Exception("下载期间本地音频已改变，请刷新后重试，未覆盖现有歌曲");
            JSONObject record = latest == null ? new JSONObject(upload.record.toString()) : new JSONObject(latest.toString());
            if (latest != null) {
                upload.metadata = SourceDownloadRules.supplement(latest.getJSONObject("metadata"), upload.source.getJSONObject("metadata")); record.put("metadata", upload.metadata);
                for (String kind : upload.offsets.keySet()) if (!record.has(kind)) record.put(kind, upload.record.getJSONObject(kind));
            }
            // A song that was already complete stays untouched: rewriting library.json and its lyric
            // files for every song made a full "supplement" pass take minutes without changing anything.
            if (latest == null || !record.toString().equals(latest.toString())) {
                lyrics(upload.directory, upload.metadata, record.getJSONObject("audio").getString("file")); index.getJSONObject("tracks").put(identifier, record); saveIndex(upload.root, index);
            }
            for (String kind : upload.offsets.keySet()) if (!record.getJSONObject(kind).getString("file").equals(upload.record.getJSONObject(kind).getString("file"))) { try { upload.directory.required(upload.record.getJSONObject(kind).getString("file")).delete(); } catch (Exception ignored) {} }
            uploads.remove(token); return null;
        });
    }
    private void cancelSourceValue(String token) {
        Upload upload = uploads.remove(token);
        if (upload != null) for (String kind : upload.offsets.keySet()) { try { upload.directory.required(upload.record.getJSONObject(kind).getString("file")).delete(); } catch (Exception ignored) {} }
    }
    void cancelSourceDownload(String token) throws Exception { nativeOperation(() -> { cancelSourceValue(token); return null; }); }
    private void run(PluginCall call, Operation operation) {
        worker.execute(() -> { try { documents.reset(); call.resolve(operation.run()); } catch (Exception error) { call.reject(error.getMessage() == null ? "音乐库操作失败，原曲库未删除" : error.getMessage()); } });
    }
    private JSObject result(JSONObject value) throws Exception { return new JSObject(value.toString()); }
    private File configFile() { return new File(getContext().getFilesDir(), "config/library-location.json"); }
    private JSONObject config() throws Exception {
        AtomicFile file = new AtomicFile(configFile());
        if (!file.getBaseFile().exists() && !new File(configFile() + ".bak").exists()) return new JSONObject();
        return new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
    }
    private void saveConfig(JSONObject value) throws Exception {
        File file = configFile();
        if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new Exception("无法保存曲库配置");
        AtomicFile atomic = new AtomicFile(file); FileOutputStream output = null;
        try { output = atomic.startWrite(); output.write(value.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(output); }
        catch (Exception error) { if (output != null) atomic.failWrite(output); throw error; }
    }
    private LibraryDocuments.Node root(String target) throws Exception {
        if (target != null) {
            LibraryDocuments.Node candidate = candidates.get(target);
            if (candidate == null) throw new Exception("文件夹选择已失效，请重新选择");
            return candidate;
        }
        String location = config().optString("uri");
        if (location.isEmpty()) throw new Exception("当前使用内部数据库，请先选择音乐库文件夹");
        return documents.inspect(Uri.parse(location));
    }
    private String cachedIndexUri;
    private String cachedIndexStamp;
    private String cachedIndexText;
    private JSONObject cachedIndex;
    private String indexStamp(LibraryDocuments.Node root) throws Exception {
        LibraryDocuments.Node file = root.child("library.json");
        if (file == null) file = root.child("library.json.backup");
        return file == null ? "missing" : file.stamp();
    }
    private JSONObject index(LibraryDocuments.Node root) throws Exception {
        String location = root.uri.toString();
        String stamp = indexStamp(root);
        // Parsing a large library.json on every call made start-up read and parse the same file
        // three times. The cache is kept until the file's size or modification time changes.
        if (cachedIndex != null && location.equals(cachedIndexUri) && stamp.equals(cachedIndexStamp)) return cachedIndex;
        String text = documents.readIndex(root, "library.json");
        if (text == null) throw new Exception("未找到 library.json，请选择完整音乐库；普通歌曲文件夹请先导入");
        JSONObject index = new JSONObject(text);
        if (!"xianqiji-library-folder".equals(index.optString("format")) || index.optInt("version") != 1 || index.optString("libraryId").isEmpty() || !(index.opt("tracks") instanceof JSONObject)) throw new Exception("不支持或已损坏的曲库清单，未覆盖文件");
        cachedIndex = index; cachedIndexUri = location; cachedIndexText = text; cachedIndexStamp = stamp; return index;
    }
    private void saveIndex(LibraryDocuments.Node root, JSONObject index) throws Exception {
        String text = index.toString(2);
        documents.atomicText(root, "library.json", text);
        cachedIndex = index; cachedIndexUri = root.uri.toString(); cachedIndexText = text; cachedIndexStamp = indexStamp(root);
    }
    private JSONObject summary(LibraryDocuments.Node root) throws Exception {
        String stamp = indexStamp(root);
        File cache = new File(getContext().getFilesDir(), "config/library-summary.json");
        try {
            JSONObject saved = new JSONObject(new String(java.nio.file.Files.readAllBytes(cache.toPath()), StandardCharsets.UTF_8));
            if (stamp.equals(saved.optString("stamp")) && saved.has("trackCount") && saved.has("libraryId")) return saved;
        } catch (Exception ignored) {}
        // Start-up only needs the song count and library id; reading the whole index for that cost a
        // full folder read on every launch, so the answer is remembered until library.json changes.
        JSONObject index = index(root);
        JSONObject summary = new JSONObject().put("stamp", indexStamp(root)).put("trackCount", index.getJSONObject("tracks").length()).put("libraryId", index.getString("libraryId"));
        try {
            File directory = cache.getParentFile(); if (directory != null && !directory.isDirectory()) directory.mkdirs();
            java.nio.file.Files.write(cache.toPath(), summary.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
        return summary;
    }
    private JSONObject cache(LibraryDocuments.Node root) throws Exception {
        String text = documents.readIndex(root, "translations-cache.json");
        JSONObject cache = text == null ? new JSONObject() : new JSONObject(text);
        Iterator<String> keys = cache.keys();
        while (keys.hasNext()) if (!(cache.get(keys.next()) instanceof String)) throw new Exception("译文缓存格式错误，未覆盖");
        return cache;
    }
    private JSONObject metadata(JSONObject value) throws Exception {
        if (value == null || !(value.opt("title") instanceof String) || !(value.opt("artist") instanceof String) || !(value.opt("lyrics") instanceof JSONArray)) throw new Exception("歌曲信息无效");
        LibraryPaths.id(value.getString("id"));
        for (int position = 0; position < value.getJSONArray("lyrics").length(); position++) {
            JSONObject line = value.getJSONArray("lyrics").getJSONObject(position);
            if (!(line.opt("text") instanceof String) || !(line.opt("time") instanceof Number) || !Double.isFinite(line.getDouble("time")) || line.has("translation") && !(line.opt("translation") instanceof String)) throw new Exception("歌词格式无效");
        }
        JSONObject clean = new JSONObject(value.toString()); clean.remove("audio"); clean.remove("cover"); return clean;
    }
    private JSONObject descriptor(JSONObject value) throws Exception {
        if (value == null || !(value.opt("type") instanceof String)) throw new Exception("歌曲文件信息无效");
        long size = SafeNumbers.fileOffset(value.opt("size"));
        return new JSONObject().put("size", size).put("type", value.getString("type"));
    }
    private LibraryDocuments.Node media(LibraryDocuments.Node root, JSONObject record, String kind) throws Exception {
        if (!kind.equals("audio") && !kind.equals("cover")) throw new Exception("无效文件类型");
        String id = LibraryPaths.id(record.getJSONObject("metadata").getString("id"));
        JSONObject file = record.getJSONObject(kind); descriptor(file);
        LibraryPaths.filename(file.getString("file"));
        if (!file.getString("sha256").matches("[a-f0-9]{64}")) throw new Exception("文件校验值无效");
        LibraryDocuments.Node node = null; String stored = file.optString("uri");
        if (stored.startsWith("content://")) {
            try { node = documents.inspect(Uri.parse(stored)); } catch (Exception ignored) { node = null; }
            if (node != null && (node.directory || !node.name.equals(file.getString("file")))) node = null;
        }
        if (node == null) node = root.required("歌曲").required(id).required(file.getString("file"));
        if (node.directory || node.size != file.getLong("size")) throw new Exception("歌曲文件缺失或大小不符：" + record.getJSONObject("metadata").getString("title"));
        return node;
    }
    private JSONObject record(LibraryDocuments.Node root, String id) throws Exception { return index(root).getJSONObject("tracks").getJSONObject(LibraryPaths.id(id)); }
    private void progress(String stage, int completed, int total) {
        JSObject event = new JSObject(); event.put("stage", stage); event.put("completed", completed); event.put("total", total); notifyListeners("progress", event);
    }
    private JSONObject verify(LibraryDocuments.Node root, boolean hashes) throws Exception {
        JSONObject index = index(root);
        String stamp = cachedIndexStamp;
        String cacheBefore = documents.readIndex(root, "translations-cache.json");
        cache(root); JSONObject tracks = index.getJSONObject("tracks");
        Iterator<String> keys = tracks.keys(); int completed = 0;
        while (keys.hasNext()) {
            String id = LibraryPaths.id(keys.next()); JSONObject record = tracks.getJSONObject(id);
            if (!id.equals(metadata(record.getJSONObject("metadata")).getString("id"))) throw new Exception("歌曲标识与索引不符");
            JSONObject audio = record.getJSONObject("audio");
            if (id.matches("[a-f0-9]{64}") && !id.equals(audio.getString("sha256"))) throw new Exception("歌曲指纹不符");
            // Resolving every audio / cover through SAF costs a cursor query per song. Listing the
            // library now trusts the index and only re-reads hashes when a full verification is asked for.
            if (hashes) {
                for (String kind : new String[] { "audio", "cover" }) if (kind.equals("audio") || record.has(kind)) {
                    LibraryDocuments.Node file = media(root, record, kind);
                    if (!file.digest().equals(record.getJSONObject(kind).getString("sha256"))) throw new Exception("文件 SHA-256 校验失败：" + file.name);
                }
                progress("校验已有音乐库", ++completed, tracks.length());
            }
        }
        if (!stamp.equals(indexStamp(root)) || !java.util.Objects.equals(cacheBefore, documents.readIndex(root, "translations-cache.json"))) throw new Exception("核验期间曲库被其他软件修改，请重试");
        return index;
    }
    private JSObject infoValue() throws Exception {
        JSONObject saved = config(); String uri = saved.optString("uri");
        JSObject value = new JSObject(); value.put("internalPath", getContext().getApplicationInfo().dataDir); value.put("previousPath", saved.optString("previousPath")); value.put("moving", false); value.put("legacyMigrated", true); value.put("uri", uri); value.put("databaseName", "tingyu-library");
        if (uri.isEmpty()) {
            value.put("storageMode", "database"); value.put("path", getContext().getApplicationInfo().dataDir + "/app_webview/（系统管理的 IndexedDB）"); value.put("trackCount", 0);
        } else {
            value.put("storageMode", "folder"); value.put("path", saved.optString("path", uri));
            try { JSONObject summary = summary(root(null)); value.put("trackCount", summary.getInt("trackCount")); value.put("libraryId", summary.getString("libraryId")); }
            catch (Exception error) { value.put("trackCount", 0); value.put("error", "目录失联或授权失效，请重新选择已有音乐库。" + error.getMessage()); }
        }
        return value;
    }
    @PluginMethod public void info(PluginCall call) { run(call, this::infoValue); }
    @PluginMethod public void useDatabase(PluginCall call) {
        run(call, () -> {
            if (!uploads.isEmpty()) throw new Exception("请先完成歌曲写入");
            JSObject previous = infoValue(); saveConfig(new JSONObject().put("previousPath", previous.getString("path"))); return infoValue();
        });
    }

    @PluginMethod public void choose(PluginCall call) {
        if (!selecting.compareAndSet(false, true)) { call.reject("文件夹选择正在进行"); return; }
        try {
            String mode = call.getString("mode", "existing");
            if (!mode.equals("copy") && !mode.equals("existing")) throw new Exception("无效的选择方式");
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            startActivityForResult(call, intent, "directoryResult");
        } catch (Exception error) { selecting.set(false); call.reject(error.getMessage()); }
    }
    @ActivityCallback private void directoryResult(PluginCall call, ActivityResult response) {
        if (call == null) { selecting.set(false); return; }
        Uri uri = response.getData() == null ? null : response.getData().getData();
        if (response.getResultCode() != Activity.RESULT_OK || uri == null) { selecting.set(false); JSObject value = new JSObject(); value.put("cancelled", true); call.resolve(value); return; }
        run(call, () -> {
            try {
                int granted = response.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                if (granted != (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) throw new Exception("需要读写授权才能保存歌词与译文");
                getContext().getContentResolver().takePersistableUriPermission(uri, granted);
                LibraryDocuments.Node selected = documents.tree(uri); int count = 0;
                if (call.getString("mode", "existing").equals("existing")) {
                    if (documents.readIndex(selected, "library.json") == null) {
                        LibraryDocuments.Node found = null;
                        for (String name : new String[] { "音乐库", "弦栖霁音乐库" }) {
                            LibraryDocuments.Node child = selected.child(name);
                            if (child != null && child.directory && documents.readIndex(child, "library.json") != null) { if (found != null) throw new Exception("存在多个曲库，请直接选择其中一个"); found = child; }
                        }
                        if (found == null) throw new Exception("未找到 library.json，请选择完整文件音乐库，ZIP 或普通音频目录仍需先导入一次");
                        selected = found;
                    }
                    JSONObject inspected = verify(selected, false);
                    if (inspected.optBoolean("copyIncomplete")) throw new Exception("该目录的复制尚未完整完成，请保留原库，重新复制到另一个空位置");
                    count = inspected.getJSONObject("tracks").length();
                } else if (selected.child("弦栖霁音乐库") != null) throw new Exception("此处已存在弦栖霁音乐库，请选择“打开已有音乐库”，或改选其他父目录");
                String token = UUID.randomUUID().toString(); candidates.put(token, selected);
                JSObject value = new JSObject(); value.put("token", token); value.put("uri", selected.uri.toString()); value.put("path", LibraryDocuments.display(selected) + (call.getString("mode", "existing").equals("copy") ? "/弦栖霁音乐库" : "")); value.put("trackCount", count); return value;
            } finally { selecting.set(false); }
        });
    }
    @PluginMethod public void create(PluginCall call) {
        run(call, () -> {
            String token = call.getString("target"); LibraryDocuments.Node parent = root(token);
            LibraryDocuments.Node selected = parent.create("弦栖霁音乐库", DocumentsContract.Document.MIME_TYPE_DIR);
            JSONObject empty = new JSONObject().put("format", "xianqiji-library-folder").put("version", 1).put("libraryId", UUID.randomUUID().toString()).put("legacyMigrated", true).put("copyIncomplete", true).put("tracks", new JSONObject());
            documents.atomicText(selected, "library.json", empty.toString(2)); candidates.put(token, selected); return new JSObject();
        });
    }
    @PluginMethod public void activate(PluginCall call) {
        run(call, () -> {
            if (!uploads.isEmpty()) throw new Exception("请先完成歌曲写入再切换曲库");
            LibraryDocuments.Node selected = root(call.getString("target")); JSONObject index = verify(selected, true);
            if (index.optBoolean("copyIncomplete")) {
                JSONArray expected = call.getArray("expectedIds"); JSONObject tracks = index.getJSONObject("tracks");
                if (expected == null || expected.length() != tracks.length()) throw new Exception("复制歌曲数不完整，未切换");
                java.util.Set<String> identifiers = new java.util.HashSet<>();
                for (int position = 0; position < expected.length(); position++) { String id = LibraryPaths.id(expected.getString(position)); if (!identifiers.add(id) || !tracks.has(id)) throw new Exception("复制歌曲清单不一致，未切换"); }
                index.remove("copyIncomplete"); saveIndex(selected, index);
            }
            String probe = ".xianqiji-write-check-" + UUID.randomUUID(); LibraryDocuments.Node test = selected.create(probe, "application/octet-stream");
            try { test.writeText("verify"); test = test.rename(probe + "-renamed"); } finally { try { test.delete(); } catch (Exception ignored) {} }
            JSObject previous = infoValue();
            saveConfig(new JSONObject().put("uri", selected.uri.toString()).put("path", LibraryDocuments.display(selected)).put("previousPath", previous.getString("path")));
            return infoValue();
        });
    }
    @PluginMethod public void list(PluginCall call) {
        run(call, () -> {
            LibraryDocuments.Node root = root(call.getString("target"));
            JSONObject index = verify(root, false); JSONObject tracks = index.getJSONObject("tracks"); JSArray values = new JSArray(); boolean changed = false;
            Iterator<String> keys = tracks.keys();
            while (keys.hasNext()) {
                JSONObject record = tracks.getJSONObject(keys.next()); JSONObject audio = record.getJSONObject("audio");
                // Older libraries stored no document URI; resolve it once and keep it in the index so
                // every later start-up reads a single JSON file instead of walking the folder tree.
                if (!audio.optString("uri").startsWith("content://")) { audio.put("uri", media(root, record, "audio").uri.toString()); changed = true; }
                values.put(record);
            }
            if (changed) saveIndex(root, index);
            JSObject value = new JSObject(); value.put("tracks", values); return value;
        });
    }
    @PluginMethod public void begin(PluginCall call) {
        run(call, () -> {
            Upload upload = new Upload(); upload.root = root(call.getString("target")); upload.metadata = metadata(call.getObject("metadata"));
            String id = upload.metadata.getString("id"); upload.directory = upload.root.folder("歌曲").folder(id);
            upload.record = new JSONObject().put("metadata", upload.metadata);
            String token = UUID.randomUUID().toString(); String base = LibraryPaths.safeName(upload.metadata.getString("artist") + " - " + upload.metadata.getString("title"));
            String format = upload.metadata.optString("format", "mp3"); if (!format.matches("[a-zA-Z0-9]{2,5}")) format = "mp3";
            for (String kind : new String[] { "audio", "cover" }) {
                JSONObject provided = call.getObject(kind); if (provided == null && kind.equals("cover")) continue;
                JSONObject file = descriptor(provided); String extension = kind.equals("audio") ? format : file.getString("type").equals("image/png") ? "png" : "jpg";
                String filename = (kind.equals("audio") ? base : "cover") + "-" + token + "." + extension;
                LibraryDocuments.Node created = upload.directory.create(filename, "application/octet-stream"); file.put("file", filename); if (kind.equals("audio")) file.put("uri", created.uri.toString()); upload.record.put(kind, file); upload.offsets.put(kind, 0L);
            }
            uploads.put(token, upload); JSObject value = new JSObject(); value.put("token", token); return value;
        });
    }
    @PluginMethod public void write(PluginCall call) {
        run(call, () -> {
            Upload upload = uploads.get(call.getString("token")); String kind = call.getString("kind", "");
            long offset = SafeNumbers.fileOffset(call.getData().opt("offset")); String encoded = call.getString("data", "");
            if (upload == null || !upload.offsets.containsKey(kind) || encoded.length() > 6 * 1024 * 1024) throw new Exception("无效音频分块");
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT); JSONObject file = upload.record.getJSONObject(kind);
            if (bytes.length > 4 * 1024 * 1024 || offset != upload.offsets.get(kind) || offset + bytes.length > file.getLong("size")) throw new Exception("音频分块位置错误");
            upload.directory.required(file.getString("file")).write(offset, bytes); upload.offsets.put(kind, offset + bytes.length); return new JSObject();
        });
    }
    private void lyrics(LibraryDocuments.Node directory, JSONObject metadata, String audioFilename) throws Exception {
        JSONArray lines = metadata.getJSONArray("lyrics"); boolean timed = false;
        for (int index = 0; index < lines.length(); index++) if (lines.getJSONObject(index).getDouble("time") >= 0) timed = true;
        int extension = audioFilename.lastIndexOf('.'); String base = extension > 0 ? audioFilename.substring(0, extension) : audioFilename;
        for (boolean translated : new boolean[] { false, true }) {
            StringBuilder text = new StringBuilder();
            for (int index = 0; index < lines.length(); index++) {
                JSONObject line = lines.getJSONObject(index); String words = translated ? line.optString("translation") : line.getString("text");
                if (words.isEmpty()) continue;
                if (text.length() > 0) text.append('\n');
                if (line.getDouble("time") >= 0) { long stamp = Math.round(line.getDouble("time") * 100); text.append(String.format(java.util.Locale.ROOT, "[%02d:%02d.%02d]", stamp / 6000, stamp / 100 % 60, stamp % 100)); }
                text.append(words);
            }
            documents.atomicText(directory, base + (translated ? ".zh" : "") + (timed ? ".lrc" : ".txt"), text.toString());
        }
        documents.atomicText(directory, "tingyu-library.json", new JSONObject().put("format", "xianqiji-library").put("version", 1).put("tracks", new JSONArray().put(metadata)).toString(2));
    }
    @PluginMethod public void finish(PluginCall call) {
        run(call, () -> {
            String token = call.getString("token"); Upload upload = uploads.get(token); JSONObject hashes = call.getObject("hashes");
            if (upload == null || hashes == null) throw new Exception("写入任务已失效");
            for (String kind : upload.offsets.keySet()) {
                JSONObject file = upload.record.getJSONObject(kind); LibraryDocuments.Node node = upload.directory.required(file.getString("file"));
                String hash = hashes.getString(kind);
                if (!hash.matches("[a-f0-9]{64}") || upload.offsets.get(kind) != file.getLong("size") || node.size != file.getLong("size") || !node.digest().equals(hash)) throw new Exception("歌曲写入不完整或 SHA-256 不符，原库保留");
                if (kind.equals("audio") && upload.metadata.getString("id").matches("[a-f0-9]{64}") && !upload.metadata.getString("id").equals(hash)) throw new Exception("音频与歌曲指纹不一致");
                file.put("sha256", hash);
            }
            lyrics(upload.directory, upload.metadata, upload.record.getJSONObject("audio").getString("file"));
            JSONObject index = index(upload.root); index.getJSONObject("tracks").put(upload.metadata.getString("id"), upload.record);
            saveIndex(upload.root, index); uploads.remove(token); return result(upload.record);
        });
    }
    @PluginMethod public void cancel(PluginCall call) {
        run(call, () -> {
            Upload upload = uploads.remove(call.getString("token"));
            if (upload != null) for (String kind : upload.offsets.keySet()) { try { upload.directory.required(upload.record.getJSONObject(kind).getString("file")).delete(); } catch (Exception ignored) {} }
            return new JSObject();
        });
    }
    private byte[] coverBlock(LibraryDocuments.Node root, JSONObject record, long offset, int length) throws Exception {
        JSONObject cover = record.getJSONObject("cover");
        File directory = new File(getContext().getFilesDir(), "cover-cache");
        File cached = new File(directory, cover.getString("sha256") + ".bin");
        if (!cached.isFile() || cached.length() != cover.getLong("size")) {
            LibraryDocuments.Node node = media(root, record, "cover");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法创建封面缓存目录");
            File pending = new File(directory, cached.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(pending)) {
                for (long position = 0; position < node.size; position += 1024 * 1024) output.write(node.read(position, (int) Math.min(1024 * 1024, node.size - position)));
            }
            if (!pending.renameTo(cached)) { pending.delete(); throw new Exception("封面缓存保存失败"); }
            trimCoverCache(directory);
        }
        try (java.io.RandomAccessFile file = new java.io.RandomAccessFile(cached, "r")) {
            byte[] bytes = new byte[length]; file.seek(offset); file.readFully(bytes); return bytes;
        }
    }
    private void trimCoverCache(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return;
        long total = 0; for (File file : files) total += file.length();
        if (total <= 128L * 1024 * 1024) return;
        java.util.Arrays.sort(files, (first, second) -> Long.compare(first.lastModified(), second.lastModified()));
        for (File file : files) { if (total <= 96L * 1024 * 1024) break; long size = file.length(); if (file.delete()) total -= size; }
    }
    @PluginMethod public void read(PluginCall call) {
        run(call, () -> {
            LibraryDocuments.Node root = root(call.getString("target")); JSONObject record = record(root, call.getString("id")); String kind = call.getString("kind", "audio");
            LibraryDocuments.Node node = media(root, record, kind); long offset = SafeNumbers.fileOffset(call.getData().opt("offset")); long length = SafeNumbers.fileOffset(call.getData().opt("length"));
            if (length > 4 * 1024 * 1024 || offset > node.size || length > node.size - offset) throw new Exception("读取分块超出文件范围");
            // Covers are re-read on every start-up and barely change, so keep a private copy instead
            // of walking the phone folder again for each one.
            byte[] bytes = kind.equals("cover") && record.has("cover") ? coverBlock(root, record, offset, (int) length) : node.read(offset, (int) length);
            JSObject value = new JSObject(); value.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)); return value;
        });
    }
    @PluginMethod public void patch(PluginCall call) {
        run(call, () -> {
            LibraryDocuments.Node root = root(null); JSONObject index = index(root); String id = LibraryPaths.id(call.getString("id")); JSONObject record = index.getJSONObject("tracks").getJSONObject(id);
            JSONObject value = new JSONObject(record.getJSONObject("metadata").toString()); JSONObject patch = call.getObject("patch"); if (patch == null) throw new Exception("歌曲修改信息为空");
            Iterator<String> keys = patch.keys(); while (keys.hasNext()) { String key = keys.next(); if (!key.equals("id") && !key.equals("audio") && !key.equals("cover")) value.put(key, patch.get(key)); }
            value = metadata(value); lyrics(root.required("歌曲").required(id), value, record.getJSONObject("audio").getString("file")); record.put("metadata", value);
            saveIndex(root, index); return result(record);
        });
    }
    @PluginMethod public void remove(PluginCall call) {
        run(call, () -> { LibraryDocuments.Node root = root(null); JSONObject index = index(root); index.getJSONObject("tracks").remove(LibraryPaths.id(call.getString("id"))); saveIndex(root, index); return new JSObject(); });
    }
    @PluginMethod public void cache(PluginCall call) {
        run(call, () -> {
            LibraryDocuments.Node root = root(call.getString("target")); JSONObject cache = cache(root); JSONArray entries = call.getArray("entries");
            if (entries != null) {
                for (int index = 0; index < entries.length(); index++) { JSONArray entry = entries.getJSONArray(index); if (entry.length() != 2 || !(entry.get(0) instanceof String) || !(entry.get(1) instanceof String)) throw new Exception("译文缓存条目无效"); cache.put(entry.getString(0), entry.getString(1)); }
                documents.atomicText(root, "translations-cache.json", cache.toString(2));
            }
            JSArray values = new JSArray(); Iterator<String> keys = cache.keys(); while (keys.hasNext()) { String key = keys.next(); values.put(new JSONArray().put(key).put(cache.getString(key))); }
            JSObject value = new JSObject(); value.put("entries", values); return value;
        });
    }
}
