package com.tingyu.music;

import android.content.ContentValues;
import android.content.Context;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

final class ProviderLoginUi {
    static void save(Context context, String image) throws Exception {
        if (image.length() > 1000000 || !image.matches("data:image/png;base64,[a-zA-Z0-9+/=]+")) throw new Exception("二维码无效，请刷新后重试");
        byte[] bytes = Base64.decode(image.substring(image.indexOf(',') + 1), Base64.DEFAULT);
        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true; BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (!"image/png".equals(bounds.outMimeType) || bounds.outWidth < 1 || bounds.outWidth > 1024 || bounds.outHeight < 1 || bounds.outHeight > 1024) throw new Exception("二维码图片无效");
        String name = "Xianqiji-login-" + System.currentTimeMillis() + ".png";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues(); values.put(MediaStore.Images.Media.DISPLAY_NAME, name); values.put(MediaStore.Images.Media.MIME_TYPE, "image/png"); values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Xianqiji"); values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("无法保存二维码到相册");
            try {
                try (OutputStream out = context.getContentResolver().openOutputStream(uri)) { if (out == null) throw new Exception("相册不可写"); out.write(bytes); }
                ContentValues finished = new ContentValues(); finished.put(MediaStore.Images.Media.IS_PENDING, 0); context.getContentResolver().update(uri, finished, null, null);
            } catch (Exception error) { context.getContentResolver().delete(uri, null, null); throw error; }
        } else {
            File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Xianqiji");
            if (!folder.isDirectory() && !folder.mkdirs()) throw new Exception("无法创建二维码相册");
            File file = new File(folder, name);
            try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); }
            catch (Exception error) { file.delete(); throw error; }
            MediaScannerConnection.scanFile(context, new String[] { file.getAbsolutePath() }, new String[] { "image/png" }, null);
        }
    }
}
