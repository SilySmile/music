package com.tingyu.music;

import android.content.Context;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;
import org.json.JSONArray;

public final class ProviderApi {
    private static final String DEVICE_GUID = java.util.UUID.randomUUID().toString().replace("-", "");
    private static final Map<String, HttpURLConnection> running = new ConcurrentHashMap<>();
    private static final Map<String, Integer> revisions = new ConcurrentHashMap<>();
    public static void cancel(String id) { HttpURLConnection connection = running.get(id); if (connection != null) connection.disconnect(); }
    public static JSONObject call(Context context, String provider, String action, JSONObject data, String id) throws Exception {
        if (!ProviderProtocol.provider(provider)) throw new Exception("无效音乐平台");
        if (action.equals("logout")) { synchronized (ProviderAccounts.class) { revisions.put(provider, revisions.getOrDefault(provider, 0) + 1); ProviderAccounts.clear(context, provider); if (provider.equals("qq")) ProviderQr.clear(); } return new JSONObject().put("code", 200); }
        if (provider.equals("qq") && action.equals("login-check")) { JSONObject state = ProviderQr.state(data.optString("key")); if (state != null) return state; }
        int revision = revisions.getOrDefault(provider, 0); JSONObject cookie = ProviderAccounts.read(context, provider);
        if (provider.equals("qq") && !cookie.has("guid")) cookie.put("guid", DEVICE_GUID);
        if (provider.equals("netease") && !cookie.has("deviceId")) { synchronized (ProviderAccounts.class) { if (revision != revisions.getOrDefault(provider, 0)) throw new Exception("账号已退出"); JSONObject latest = ProviderAccounts.read(context, provider); if (!latest.has("deviceId")) latest.put("deviceId", DEVICE_GUID); ProviderAccounts.save(context, provider, latest); cookie.put("deviceId", latest.getString("deviceId")); } }
        ProviderProtocol.Request built = ProviderProtocol.build(provider, action, data, cookie);
        JSONObject result = perform(context, provider, action, built, id, revision, cookie);
        if (provider.equals("qq") && action.equals("login-create") && result.optInt("code", -1) == 0 && result.optJSONObject("req_0") != null && result.getJSONObject("req_0").optInt("code", -1) == 0) {
            String key = result.getJSONObject("req_0").getJSONObject("data").getString("qrcodeID"); ProviderQr.begin(context, key, cookie.getString("guid"), revision);
            if (revision != revisions.getOrDefault(provider, 0)) { ProviderQr.clear(); throw new Exception("账号已退出"); }
        }
        return result;
    }
    static void exchange(Context context, String key, String guid, int revision, JSONObject payload) throws Exception {
        JSONObject cookies = payload.optJSONObject("cookies"); if (cookies == null) cookies = new JSONObject();
        JSONObject idCookie = cookies.optJSONObject("qqmusic_uin"); if (idCookie == null) idCookie = cookies.optJSONObject("uin");
        JSONObject keyCookie = cookies.optJSONObject("qqmusic_key"); if (keyCookie == null) keyCookie = cookies.optJSONObject("qm_keyst");
        String uin = idCookie == null ? payload.optString("uin") : idCookie.optString("value"), token = keyCookie == null ? payload.optString("musickey") : keyCookie.optString("value");
        if (!uin.matches("[0-9]{1,16}") || token.isEmpty() || token.length() > 4096) throw new Exception("QQ 扫码确认信息不完整");
        JSONObject cookie = new JSONObject().put("guid", guid); ProviderProtocol.Request template = ProviderProtocol.build("qq", "session", new JSONObject(), cookie);
        JSONObject body = new JSONObject(template.body); body.getJSONObject("comm").put("tmeLoginType", 6); body.put("req_0", new JSONObject().put("module", "music.login.LoginServer").put("method", "Login").put("param", new JSONObject().put("musicid", Long.parseLong(uin)).put("qrCodeID", key).put("token", token)));
        perform(context, "qq", "login-exchange", new ProviderProtocol.Request(template.url, body.toString(), template.referer, true), java.util.UUID.randomUUID().toString(), revision, cookie);
    }
    private static JSONObject perform(Context context, String provider, String action, ProviderProtocol.Request built, String id, int revision, JSONObject cookie) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(built.url).openConnection(); running.put(id, connection);
        try {
            connection.setConnectTimeout(15000); connection.setReadTimeout(20000); connection.setInstanceFollowRedirects(false); connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", provider.equals("qq") ? "application/json" : "application/x-www-form-urlencoded"); connection.setRequestProperty("Referer", built.referer); connection.setRequestProperty("User-Agent", built.userAgent);
            if (provider.equals("qq")) connection.setRequestProperty("Origin", "https://y.qq.com");
            StringBuilder cookies = new StringBuilder(); for (Iterator<String> keys = cookie.keys(); keys.hasNext();) { String key = keys.next(); if (cookies.length() > 0) cookies.append("; "); cookies.append(key).append('=').append(cookie.getString(key)); } if (cookies.length() > 0) connection.setRequestProperty("Cookie", cookies.toString());
            if (built.cookieHeader != null) connection.setRequestProperty("Cookie", built.cookieHeader);
            byte[] bytes = built.body.getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(bytes.length); try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            int status = connection.getResponseCode(); if (status != 200) throw new Exception("音乐平台响应失败（HTTP " + status + "）");
            JSONObject response;
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) { byte[] buffer = new byte[8192]; int size; while ((size = input.read(buffer)) != -1) { if (output.size() + size > 4 * 1024 * 1024) throw new Exception("音乐平台响应过大"); output.write(buffer, 0, size); } response = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8)); }
            JSONObject changed = new JSONObject();
            for (Map.Entry<String, java.util.List<String>> header : connection.getHeaderFields().entrySet()) if ("set-cookie".equalsIgnoreCase(header.getKey())) for (String item : header.getValue()) { String pair = item.split(";", 2)[0]; int at = pair.indexOf('='); if (at > 0 && pair.substring(0, at).matches("[a-zA-Z0-9_-]+")) changed.put(pair.substring(0, at), pair.substring(at + 1)); }
            if (provider.equals("qq")) {
                JSONObject envelope = response.optJSONObject("req_0"), login = envelope == null ? null : envelope.optJSONObject("data");
                if (login != null && login.optJSONObject("data") != null) { JSONObject inner = login.getJSONObject("data"); for (Iterator<String> keys = inner.keys(); keys.hasNext();) { String key = keys.next(); if (!login.has(key)) login.put(key, inner.get(key)); } }
                if (login != null && !login.has("musicid") && login.has("str_musicid")) login.put("musicid", login.get("str_musicid"));
                if (login != null && !login.optString("musickey", "").isEmpty() && !login.optString("musicid", login.optString("uin", "")).isEmpty()) {
                    changed.put("qm_keyst", login.getString("musickey")); changed.put("qqmusic_key", login.getString("musickey")); changed.put("uin", login.optString("musicid", login.optString("uin"))); changed.put("qqmusic_uin", changed.getString("uin"));
                    changed.put("musicid", changed.getString("uin")); changed.put("guid", cookie.getString("guid"));
                    for (String key : new String[] { "refresh_token", "refresh_key", "openid", "access_token" }) if (login.has(key)) changed.put(key, login.get(key).toString());
                }
            }
            synchronized (ProviderAccounts.class) {
                if (revision != revisions.getOrDefault(provider, 0)) throw new Exception("账号已退出，请重新操作");
                if (action.equals("login-exchange") && (response.optInt("code", -1) != 0 || response.getJSONObject("req_0").optInt("code", -1) != 0 || !changed.has("qm_keyst"))) throw new Exception("QQ 未接受本次扫码确认，请刷新二维码");
                if (changed.length() > 0) { JSONObject latest = ProviderAccounts.read(context, provider); for (Iterator<String> keys = changed.keys(); keys.hasNext();) { String key = keys.next(); latest.put(key, changed.get(key)); } ProviderAccounts.save(context, provider, latest); }
            }
            return (JSONObject) redact(response);
        } finally { running.remove(id); connection.disconnect(); }
    }
    private static Object redact(Object value) throws Exception {
        if (value instanceof JSONArray) { JSONArray output = new JSONArray(); for (int i = 0; i < ((JSONArray)value).length(); i++) output.put(redact(((JSONArray)value).get(i))); return output; }
        if (value instanceof JSONObject) { JSONObject output = new JSONObject(); for (Iterator<String> keys = ((JSONObject)value).keys(); keys.hasNext();) { String key = keys.next(); if (!key.matches("(?i)musickey|qm_keyst|qqmusic_key|refresh_token|refresh_key|access_token|login_key|cookie|cookieStr")) output.put(key, redact(((JSONObject)value).get(key))); } return output; }
        return value;
    }
}
