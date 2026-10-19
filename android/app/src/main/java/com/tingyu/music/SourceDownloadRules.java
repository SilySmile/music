package com.tingyu.music;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

final class SourceDownloadRules {
    static String baseUrl(String value) throws Exception {
        URI uri = new URI(value);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !value.endsWith("/") || !uri.normalize().equals(uri)) throw new Exception("音源地址必须是不含账号、参数或跳转的 HTTPS 地址");
        return uri.toASCIIString();
    }
    static String digest(byte[] bytes) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    static String identity(String base, String token) throws Exception { return digest((base + "|" + token).getBytes(StandardCharsets.UTF_8)); }
    static void validate(JSONObject remote, String identifier) throws Exception {
        JSONObject metadata = remote.getJSONObject("metadata");
        if (!identifier.matches("[a-f0-9]{64}") || !identifier.equals(metadata.getString("id")) || !(metadata.opt("title") instanceof String) || !(metadata.opt("artist") instanceof String) || !(metadata.opt("album") instanceof String) || !(metadata.opt("format") instanceof String) || !Double.isFinite(metadata.getDouble("duration")) || SafeNumbers.fileOffset(remote.opt("revision")) < 1) throw new Exception("云端歌曲信息或标识无效");
        JSONArray lyrics = metadata.getJSONArray("lyrics");
        for (int index = 0; index < lyrics.length(); index++) {
            JSONObject line = lyrics.getJSONObject(index);
            if (!(line.opt("text") instanceof String) || !(line.opt("time") instanceof Number) || !Double.isFinite(line.getDouble("time")) || line.has("translation") && !(line.opt("translation") instanceof String)) throw new Exception("云端歌词格式无效");
        }
        for (String kind : new String[] { "audio", "cover" }) if (remote.has(kind)) {
            JSONObject media = remote.getJSONObject(kind);
            if (SafeNumbers.fileOffset(media.opt("size")) < 1 || !(media.opt("type") instanceof String) || !media.getString("sha256").matches("[a-f0-9]{64}")) throw new Exception("云端文件描述无效");
        }
        if (!identifier.equals(remote.getJSONObject("audio").getString("sha256"))) throw new Exception("云端音频指纹不符");
    }
    private static boolean words(JSONObject line) throws Exception {
        JSONArray words = line.optJSONArray("words");
        if (words == null || words.length() == 0 || words.length() > 6000 || line.getDouble("time") < 0) return false;
        StringBuilder text = new StringBuilder(); double previous = line.getDouble("time");
        for (int index = 0; index < words.length(); index++) {
            JSONObject word = words.optJSONObject(index);
            if (word == null || !(word.opt("text") instanceof String) || word.getString("text").isEmpty() || !(word.opt("time") instanceof Number) || !Double.isFinite(word.getDouble("time")) || word.getDouble("time") < previous || word.has("endTime") && (!(word.opt("endTime") instanceof Number) || !Double.isFinite(word.getDouble("endTime")) || word.getDouble("endTime") < word.getDouble("time"))) return false;
            previous = word.getDouble("time"); text.append(word.getString("text"));
        }
        return text.toString().equals(line.getString("text"));
    }
    private static boolean endTime(JSONObject line) throws Exception { return line.getDouble("time") >= 0 && line.opt("endTime") instanceof Number && Double.isFinite(line.getDouble("endTime")) && line.getDouble("endTime") > line.getDouble("time"); }
    static JSONObject supplement(JSONObject local, JSONObject remote) throws Exception {
        JSONObject result = new JSONObject(local.toString()); JSONArray original = result.getJSONArray("lyrics"); JSONArray incoming = remote.getJSONArray("lyrics");
        if (original.length() == 0) { result.put("lyrics", new JSONArray(incoming.toString())); if (remote.has("lyricsSource")) result.put("lyricsSource", remote.get("lyricsSource")); }
        else {
            Map<String, JSONObject> lookup = new HashMap<>();
            for (int index = 0; index < incoming.length(); index++) { JSONObject line = incoming.getJSONObject(index); lookup.put(Math.round(line.getDouble("time") * 100) + "|" + line.getString("text").trim(), line); }
            for (int index = 0; index < original.length(); index++) {
                JSONObject line = original.getJSONObject(index); JSONObject other = lookup.get(Math.round(line.getDouble("time") * 100) + "|" + line.getString("text").trim());
                if (other == null) continue;
                if (line.optString("translation").isEmpty() && other.has("translation")) line.put("translation", other.get("translation"));
                if (!endTime(line) && endTime(other)) line.put("endTime", other.get("endTime"));
                if (!words(line) && words(other)) { line.put("words", new JSONArray(other.getJSONArray("words").toString())); line.remove("wordTiming"); line.remove("timingNote"); if ("estimated".equals(other.optString("wordTiming"))) { line.put("wordTiming", "estimated"); if (other.opt("timingNote") instanceof String) line.put("timingNote", other.getString("timingNote").substring(0, Math.min(600, other.getString("timingNote").length()))); } }
            }
        }
        if (result.optString("translationSource").isEmpty() && remote.has("translationSource")) result.put("translationSource", remote.get("translationSource"));
        if (!result.has("translationAudit") && original.length() == 0 && remote.has("translationAudit")) result.put("translationAudit", remote.get("translationAudit"));
        return result;
    }
}
