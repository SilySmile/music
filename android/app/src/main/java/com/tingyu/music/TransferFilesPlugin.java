package com.tingyu.music;

import android.util.Base64;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.File;
import java.io.RandomAccessFile;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "TransferFiles")
public class TransferFilesPlugin extends Plugin {
    private final ExecutorService copies = Executors.newSingleThreadExecutor();
    private final AtomicBoolean saving = new AtomicBoolean(false);

    @Override
    protected void handleOnDestroy() { copies.shutdownNow(); }
    private File target(PluginCall call) throws Exception {
        String identifier = call.getString("id", "");
        if (!identifier.matches("[a-zA-Z0-9-]{1,80}")) throw new Exception("无效的传输任务");
        File directory = new File(getContext().getFilesDir(), "transfer-exports");
        if (!directory.exists() && !directory.mkdirs()) throw new Exception("无法创建导出目录，请检查设备空间");
        return new File(directory, identifier + ".zip");
    }

    @PluginMethod
    public void open(PluginCall call) {
        try {
            File file = target(call);
            if (!file.exists() && !file.createNewFile()) throw new Exception("无法创建导出文件");
            JSObject result = new JSObject();
            result.put("location", file.toURI().toString());
            result.put("size", file.length());
            call.resolve(result);
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            long offset = SafeNumbers.fileOffset(call.getData().opt("offset"));
            String data = call.getString("data", "");
            if (data.length() > 12 * 1024 * 1024) throw new Exception("无效的文件分块");
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            try (RandomAccessFile output = new RandomAccessFile(target(call), "rw")) {
                output.seek(offset);
                output.write(bytes);
                output.getFD().sync();
            }
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        try {
            long size = SafeNumbers.fileOffset(call.getData().opt("size"));
            File file = target(call);
            try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
                output.setLength(size);
                output.getFD().sync();
            }
            JSObject result = new JSObject();
            result.put("location", file.toURI().toString());
            call.resolve(result);
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod
    public void saveAs(PluginCall call) {
        if (!saving.compareAndSet(false, true)) { call.reject("另存正在进行，请等待完成或取消。"); return; }
        try {
            if (!target(call).isFile()) throw new Exception("音乐包不存在，请重新导出");
            String filename = call.getString("filename", "弦栖霁音乐包.zip");
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/zip");
            intent.putExtra(Intent.EXTRA_TITLE, filename.replaceAll("[\\\\/:*?\"<>|]", "_"));
            startActivityForResult(call, intent, "saveResult");
        } catch (Exception error) { saving.set(false); call.reject(error.getMessage()); }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) { saving.set(false); return; }
        Uri destination = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || destination == null) { saving.set(false); call.reject("已取消另存，应用内音乐包仍保留，可再次保存。"); return; }
        copies.execute(() -> {
            try (FileInputStream input = new FileInputStream(target(call)); OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                if (output == null) throw new Exception("无法写入所选位置，请检查文件权限和剩余空间");
                byte[] buffer = new byte[1024 * 1024];
                int length;
                while ((length = input.read(buffer)) != -1) { if (Thread.currentThread().isInterrupted()) throw new Exception("另存已中断"); output.write(buffer, 0, length); }
                output.flush();
                JSObject response = new JSObject(); response.put("location", destination.toString()); call.resolve(response);
            } catch (Exception error) { call.reject("另存失败，应用内音乐包已保留：" + error.getMessage()); }
            finally { saving.set(false); }
        });
    }
}
