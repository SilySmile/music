package com.tingyu.music;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class ProviderAccounts {
    private static AtomicFile file(Context context, String provider) throws Exception {
        if (!ProviderProtocol.provider(provider)) throw new Exception("无效音乐平台");
        File directory = new File(context.getNoBackupFilesDir(), "config"); if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法保存音乐账号");
        return new AtomicFile(new File(directory, "provider-" + provider + ".json"));
    }
    private static SecretKey key(String provider) throws Exception {
        String alias = "xianqiji-provider-" + provider + "-v1"; KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore"); generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); return generator.generateKey();
    }
    static synchronized JSONObject read(Context context, String provider) throws Exception {
        AtomicFile file = file(context, provider); if (!file.getBaseFile().isFile()) return new JSONObject();
        try { JSONObject saved = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8)); Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(provider), new GCMParameterSpec(128, Base64.decode(saved.getString("iv"), Base64.NO_WRAP))); return new JSONObject(new String(cipher.doFinal(Base64.decode(saved.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8)); }
        catch (Exception error) { throw new Exception("音乐账号凭据无法解密，请退出账号后重新登录"); }
    }
    static synchronized void save(Context context, String provider, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(provider));
        JSONObject saved = new JSONObject(); saved.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)); saved.put("data", Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        AtomicFile file = file(context, provider); FileOutputStream output = file.startWrite(); try { output.write(saved.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); } catch (Exception error) { file.failWrite(output); throw error; }
    }
    static synchronized void clear(Context context, String provider) throws Exception { file(context, provider).delete(); }
}
