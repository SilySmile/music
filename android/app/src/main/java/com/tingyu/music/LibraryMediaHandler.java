package com.tingyu.music;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.AtomicFile;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

final class LibraryMediaHandler {
    static final String PREFIX = "/__xianqiji_library__/";
    private final Context context;
    private final Map<String, String> verified = new ConcurrentHashMap<>();
    LibraryMediaHandler(Context context) { this.context = context; }

    WebResourceResponse handle(WebResourceRequest request) {
        Map<String, String> headers = new HashMap<>(); headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff"); headers.put("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"); headers.put("Accept-Ranges", "bytes");
        try {
            if (!request.getMethod().equals("GET") && !request.getMethod().equals("HEAD")) return response(405, "Method Not Allowed", headers);
            String id = LibraryPaths.id(request.getUrl().getPath().substring(PREFIX.length()));
            JSONObject config = new JSONObject(new String(new AtomicFile(new File(context.getFilesDir(), "config/library-location.json")).readFully(), StandardCharsets.UTF_8));
            LibraryDocuments documents = new LibraryDocuments(context.getContentResolver()); LibraryDocuments.Node root = documents.inspect(Uri.parse(config.getString("uri")));
            String indexText = documents.readIndex(root, "library.json"); JSONObject index = new JSONObject(indexText);
            if (!index.getString("format").equals("xianqiji-library-folder") || index.getInt("version") != 1) throw new Exception("Invalid library");
            JSONObject record = index.getJSONObject("tracks").getJSONObject(id); JSONObject media = record.getJSONObject("audio");
            LibraryDocuments.Node node = root.required("歌曲").required(id).required(LibraryPaths.filename(media.getString("file")));
            long size = SafeNumbers.fileOffset(media.get("size"));
            if (node.directory || node.size != size || !media.getString("sha256").matches("[a-f0-9]{64}")) throw new Exception("Invalid media");
            if (!id.equals(record.getJSONObject("metadata").getString("id")) || id.matches("[a-f0-9]{64}") && !id.equals(media.getString("sha256"))) throw new Exception("Invalid song identity");
            long modified = 0;
            try (Cursor cursor = context.getContentResolver().query(node.uri, new String[] { DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null)) { if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) modified = cursor.getLong(0); }
            String fingerprint = node.uri + "|" + size + "|" + modified + "|" + media.getString("sha256");
            if (modified <= 0 || !fingerprint.equals(verified.get(id))) {
                if (!node.digest().equals(media.getString("sha256"))) throw new Exception("Audio checksum mismatch");
                if (modified > 0) verified.put(id, fingerprint);
            }
            String rangeHeader = null;
            for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) if (header.getKey().equalsIgnoreCase("Range")) rangeHeader = header.getValue();
            LibraryRange range;
            try { range = LibraryRange.parse(rangeHeader, size); }
            catch (IllegalArgumentException error) { headers.put("Content-Range", "bytes */" + size); return response(416, "Range Not Satisfiable", headers); }
            headers.put("Content-Length", Long.toString(range.length()));
            if (range.partial) headers.put("Content-Range", "bytes " + range.start + "-" + range.end + "/" + size);
            InputStream stream = new ByteArrayInputStream(new byte[0]);
            if (!request.getMethod().equals("HEAD") && range.length() > 0) {
                ParcelFileDescriptor descriptor = context.getContentResolver().openFileDescriptor(node.uri, "r");
                if (descriptor == null) throw new IOException("Media access lost");
                ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
                try { input.getChannel().position(range.start); }
                catch (Exception error) { input.close(); throw error; }
                stream = new FilterInputStream(input) {
                    private long remaining = range.length();
                    @Override public int read() throws IOException { if (remaining == 0) return -1; int value = in.read(); if (value >= 0) remaining--; return value; }
                    @Override public int read(byte[] bytes, int offset, int length) throws IOException { if (length == 0) return 0; if (remaining == 0) return -1; int count = in.read(bytes, offset, (int) Math.min(length, remaining)); if (count > 0) remaining -= count; return count; }
                    @Override public long skip(long length) throws IOException { long skipped = in.skip(Math.min(length, remaining)); remaining -= skipped; return skipped; }
                    @Override public int available() throws IOException { return (int) Math.min(Integer.MAX_VALUE, Math.min(in.available(), remaining)); }
                };
            }
            return new WebResourceResponse(media.getString("type"), null, range.partial ? 206 : 200, range.partial ? "Partial Content" : "OK", headers, stream);
        } catch (Exception error) { return response(404, "Not Found", headers); }
    }
    private WebResourceResponse response(int code, String reason, Map<String, String> headers) { return new WebResourceResponse("text/plain", "UTF-8", code, reason, headers, new ByteArrayInputStream(new byte[0])); }
}
