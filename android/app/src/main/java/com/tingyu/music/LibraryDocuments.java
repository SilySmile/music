package com.tingyu.music;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;

final class LibraryDocuments {
    private final ContentResolver resolver;
    private final Map<String, List<Node>> listings = new HashMap<>();
    LibraryDocuments(ContentResolver resolver) { this.resolver = resolver; }
    void reset() { listings.clear(); }

    final class Node {
        final Uri uri;
        final String name;
        final boolean directory;
        final long size;
        Node(Uri uri, String name, boolean directory, long size) { this.uri = uri; this.name = name; this.directory = directory; this.size = size; }

        List<Node> children() throws Exception {
            if (!directory) throw new Exception("所选位置不是文件夹");
            List<Node> existing = listings.get(uri.toString());
            if (existing != null) return existing;
            List<Node> nodes = new ArrayList<>();
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(uri, DocumentsContract.getDocumentId(uri));
            String[] columns = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE };
            try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
                if (cursor == null) throw new Exception("无法列出音乐库目录，请重新授权");
                while (cursor.moveToNext()) nodes.add(new Node(DocumentsContract.buildDocumentUriUsingTree(uri, cursor.getString(0)), cursor.getString(1), DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2)), cursor.isNull(3) ? -1 : cursor.getLong(3)));
            }
            listings.put(uri.toString(), nodes); return nodes;
        }

        Node child(String filename) throws Exception {
            LibraryPaths.filename(filename);
            Node found = null;
            for (Node node : children()) if (node.name.equals(filename)) { if (found != null) throw new Exception("目录内存在重名文件，未修改音乐库"); found = node; }
            return found;
        }

        Node required(String filename) throws Exception {
            Node node = child(filename);
            if (node == null) throw new Exception("音乐库缺少文件：" + filename);
            return node;
        }

        Node create(String filename, String mime) throws Exception {
            LibraryPaths.filename(filename);
            if (child(filename) != null) throw new Exception("目标文件已存在，未覆盖：" + filename);
            Uri created = DocumentsContract.createDocument(resolver, uri, mime, filename);
            if (created == null) throw new Exception("无法写入所选目录，请检查权限和空间");
            reset();
            Node node = inspect(created);
            if (!node.name.equals(filename)) throw new Exception("文件提供器自动改名，未切换音乐库");
            return node;
        }

        Node folder(String filename) throws Exception {
            Node found = child(filename);
            if (found == null) return create(filename, DocumentsContract.Document.MIME_TYPE_DIR);
            if (!found.directory) throw new Exception("音乐库子目录被同名文件占用");
            return found;
        }

        String text() throws Exception {
            if (directory) throw new Exception("音乐库文本不是普通文件");
            try (InputStream input = resolver.openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (input == null) throw new Exception("音乐库无法读取");
                byte[] buffer = new byte[8192]; int length;
                while ((length = input.read(buffer)) != -1) { if (output.size() + length > 32 * 1024 * 1024) throw new Exception("曲库索引超过安全读取范围"); output.write(buffer, 0, length); }
                return output.toString(StandardCharsets.UTF_8.name());
            }
        }

        void writeText(String value) throws Exception {
            try (OutputStream output = resolver.openOutputStream(uri, "wt")) {
                if (output == null) throw new Exception("无法写入音乐库文件");
                output.write(value.getBytes(StandardCharsets.UTF_8)); output.flush();
            }
            reset();
            if (!text().equals(value)) throw new Exception("音乐库写入后回读不一致，未切换");
        }

        Node rename(String filename) throws Exception {
            Uri renamed = DocumentsContract.renameDocument(resolver, uri, LibraryPaths.filename(filename));
            if (renamed == null) throw new Exception("所选文件提供器不支持安全改名，请选择手机本地文件夹");
            reset();
            Node result = inspect(renamed);
            if (!result.name.equals(filename)) throw new Exception("文件提供器改名结果不符");
            return result;
        }

        void delete() throws Exception { if (!DocumentsContract.deleteDocument(resolver, uri)) throw new Exception("无法删除临时文件"); reset(); }

        String digest() throws Exception {
            if (directory) throw new Exception("音频不是普通文件");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = resolver.openInputStream(uri)) {
                if (input == null) throw new Exception("音频文件无法读取");
                byte[] buffer = new byte[1024 * 1024]; int length;
                while ((length = input.read(buffer)) != -1) { if (Thread.currentThread().isInterrupted()) throw new Exception("文件校验中断"); digest.update(buffer, 0, length); }
            }
            StringBuilder result = new StringBuilder();
            for (byte value : digest.digest()) result.append(String.format("%02x", value & 255));
            return result.toString();
        }

        byte[] read(long offset, int length) throws Exception {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "r");
            if (descriptor == null) throw new Exception("音频读取权限已失效");
            try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                input.getChannel().position(offset);
                byte[] bytes = new byte[length]; int read = 0;
                while (read < length) { int count = input.read(bytes, read, length - read); if (count < 0) throw new Exception("音频文件不完整"); read += count; }
                return bytes;
            }
        }

        void write(long offset, byte[] bytes) throws Exception {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "rw");
            if (descriptor == null) throw new Exception("音频写入权限已失效");
            try (ParcelFileDescriptor.AutoCloseOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
                output.getChannel().position(offset); output.write(bytes); output.flush(); output.getFD().sync();
            }
            reset();
        }
    }

    Node inspect(Uri uri) throws Exception {
        String[] columns = { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE };
        try (Cursor cursor = resolver.query(uri, columns, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new Exception("音乐库位置不可访问，请重新选择文件夹授权");
            return new Node(uri, cursor.getString(0), DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1)), cursor.isNull(2) ? -1 : cursor.getLong(2));
        }
    }

    Node tree(Uri uri) throws Exception {
        if (!"content".equals(uri.getScheme()) || !DocumentsContract.isTreeUri(uri)) throw new Exception("请选择系统授权的音乐库文件夹");
        return inspect(DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri)));
    }

    String readIndex(Node root, String name) throws Exception {
        Node current = root.child(name);
        if (current == null) current = root.child(name + ".backup");
        return current == null ? null : current.text();
    }

    void atomicText(Node root, String name, String text) throws Exception {
        Node pending = root.child(name + ".pending");
        if (pending != null) pending.delete();
        pending = root.create(name + ".pending", "application/octet-stream");
        pending.writeText(text);
        Node current = root.child(name);
        Node backup = root.child(name + ".backup");
        if (current != null) {
            if (backup != null) backup.delete();
            backup = current.rename(name + ".backup");
        }
        try {
            Node committed = pending.rename(name);
            if (!committed.text().equals(text)) throw new Exception("曲库索引回读失败");
        } catch (Exception failure) {
            if (root.child(name) == null && backup != null) backup.rename(name);
            throw failure;
        }
        if (backup != null) { try { backup.delete(); } catch (Exception ignored) {} }
    }

    static String display(Node root) {
        String id = DocumentsContract.getDocumentId(root.uri);
        if ("com.android.externalstorage.documents".equals(root.uri.getAuthority()) && id.startsWith("primary:")) return "/storage/emulated/0/" + id.substring(8);
        return root.name + "（" + id + "）";
    }
}
