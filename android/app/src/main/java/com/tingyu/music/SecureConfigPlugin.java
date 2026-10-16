package com.tingyu.music;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "SecureConfig")
public class SecureConfigPlugin extends Plugin {
    private static final String ALIAS = "xianqiji-ai-config-v1";

    private String slot(PluginCall call) throws Exception {
        String slot = call.getString("slot", "ai");
        if (!slot.equals("ai") && !slot.equals("cloud")) throw new Exception("无效的安全配置类型");
        return slot;
    }

    private AtomicFile config(PluginCall call) throws Exception {
        File directory = new File(getContext().getNoBackupFilesDir(), "config");
        if (!directory.exists() && !directory.mkdirs()) throw new Exception("无法创建安全配置目录");
        return new AtomicFile(new File(directory, slot(call).equals("cloud") ? "online-source.json" : "ai-config.json"));
    }

    private SecretKey key(boolean create, String slot) throws Exception {
        String alias = slot.equals("cloud") ? "xianqiji-online-source-v1" : ALIAS;
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new Exception("系统密钥不存在，请重新填写 API Key");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    @PluginMethod
    public void loadKey(PluginCall call) {
        try {
            AtomicFile file = config(call); String value = "";
            if (file.getBaseFile().exists()) {
                JSONObject envelope = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(false, slot(call)), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
                value = new String(cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8);
            }
            JSObject response = new JSObject(); response.put("key", value); response.put("path", file.getBaseFile().getAbsolutePath()); call.resolve(response);
        } catch (Exception error) { call.reject("安全配置无法解密，请重新填写密钥：" + error.getMessage()); }
    }

    @PluginMethod
    public void saveKey(PluginCall call) {
        try {
            String value = call.getString("key", "").trim();
            if (value.isEmpty() || value.length() > (slot(call).equals("cloud") ? 8192 : 1000) || value.contains("\n") || value.contains("\r")) throw new Exception("无效的安全配置");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true, slot(call)));
            JSONObject envelope = new JSONObject(); envelope.put("version", 1); envelope.put("encryption", "AndroidKeyStore-AES-GCM");
            envelope.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
            envelope.put("ciphertext", Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
            AtomicFile file = config(call); FileOutputStream stream = null;
            try { stream = file.startWrite(); stream.write(envelope.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(stream); }
            catch (Exception error) { if (stream != null) file.failWrite(stream); throw error; }
            call.resolve();
        } catch (Exception error) { call.reject("密钥加密保存失败：" + error.getMessage()); }
    }

    @PluginMethod
    public void clearKey(PluginCall call) {
        try { config(call).delete(); call.resolve(); }
        catch (Exception error) { call.reject(error.getMessage()); }
    }
}
