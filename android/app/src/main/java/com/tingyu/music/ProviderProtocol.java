package com.tingyu.music;

import java.nio.charset.StandardCharsets;
import java.math.BigInteger;
import java.net.URLEncoder;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import javax.crypto.spec.IvParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Platform protocol requests only; account cookies never cross the WebView bridge. */
public final class ProviderProtocol {
    private static final String MODULUS = "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
    public static final class Request {
        public final String url, body, referer, userAgent;
        public Request(String url, String body, String referer, boolean mobile) {
            this.url = url; this.body = body; this.referer = referer;
            this.userAgent = mobile ? "QQMusic 20090008(android 14)" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
        }
    }
    public static boolean provider(String value) { return "qq".equals(value) || "netease".equals(value); }
    private static JSONObject object(Object... pairs) throws Exception { JSONObject result = new JSONObject(); for (int i = 0; i < pairs.length; i += 2) result.put((String)pairs[i], pairs[i + 1]); return result; }
    private static String base64(byte[] bytes) {
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; StringBuilder output = new StringBuilder();
        for (int i = 0; i < bytes.length; i += 3) { int value = ((bytes[i] & 255) << 16) | (i + 1 < bytes.length ? (bytes[i + 1] & 255) << 8 : 0) | (i + 2 < bytes.length ? bytes[i + 2] & 255 : 0); output.append(alphabet.charAt((value >>> 18) & 63)).append(alphabet.charAt((value >>> 12) & 63)).append(i + 1 < bytes.length ? alphabet.charAt((value >>> 6) & 63) : '=').append(i + 2 < bytes.length ? alphabet.charAt(value & 63) : '='); }
        return output.toString();
    }
    private static String aes(String text, String key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding"); cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"), new IvParameterSpec("0102030405060708".getBytes(StandardCharsets.UTF_8)));
        return base64(cipher.doFinal(text.getBytes(StandardCharsets.UTF_8)));
    }
    static String weapi(JSONObject value, String secret) throws Exception {
        String rsa = new BigInteger(1, new StringBuilder(secret).reverse().toString().getBytes(StandardCharsets.UTF_8)).modPow(BigInteger.valueOf(65537), new BigInteger(MODULUS, 16)).toString(16);
        StringBuilder padded = new StringBuilder(); for (int i = rsa.length(); i < 256; i++) padded.append('0'); padded.append(rsa);
        return "params=" + URLEncoder.encode(aes(aes(value.toString(), "0CoJUm6Qyw8W8jud"), secret), "UTF-8") + "&encSecKey=" + padded;
    }
    public static Request build(String provider, String action, JSONObject data, JSONObject cookie) throws Exception {
        if (!provider(provider)) throw new Exception("无效音乐平台");
        String id = data.optString("id", "");
        if ((action.equals("detail") || action.equals("playback") || action.equals("download")) && !id.matches(provider.equals("qq") ? "[a-zA-Z0-9]{1,40}" : "[0-9]{1,20}")) throw new Exception("歌曲标识无效");
        String query = data.optString("query", "").trim(); int page = Math.max(1, Math.min(1000, data.optInt("page", 1)));
        if (action.equals("search") && (query.isEmpty() || query.length() > 200)) throw new Exception("搜索内容无效");
        if (action.equals("login-check") && !data.optString("key", "").matches("[a-zA-Z0-9_-]{1,200}")) throw new Exception("扫码会话无效");
        if (provider.equals("netease")) {
            String path; JSONObject payload;
            switch (action) {
                case "search": path = "/cloudsearch/pc"; payload = object("s", query, "type", 1, "limit", 20, "offset", (page - 1) * 20, "total", true); break;
                case "login-create": path = "/login/qrcode/unikey"; payload = object("type", 3); break;
                case "login-check": path = "/login/qrcode/client/login"; payload = object("key", data.getString("key"), "type", 3); break;
                case "session": path = "/w/nuser/account/get"; payload = object(); break;
                case "detail": path = "/v3/song/detail"; payload = object("c", new JSONArray().put(object("id", id)).toString()); break;
                case "playback": path = "/song/enhance/player/url/v1"; payload = object("ids", new JSONArray().put(id).toString(), "level", "standard", "encodeType", "mp3"); break;
                case "download": path = "/song/enhance/download/url"; payload = object("id", id, "br", 128000); break;
                case "logout": path = "/logout"; payload = object(); break;
                default: throw new Exception("不支持此音乐操作");
            }
            payload.put("csrf_token", cookie.optString("__csrf", ""));
            byte[] random = new byte[8]; new SecureRandom().nextBytes(random); StringBuilder secret = new StringBuilder(); for (byte item : random) secret.append(String.format("%02x", item));
            return new Request("https://music.163.com/weapi" + path + "?csrf_token=" + URLEncoder.encode(cookie.optString("__csrf", ""), "UTF-8"), weapi(payload, secret.toString()), "https://music.163.com/", false);
        }
        String module, method; JSONObject payload;
        String guid = cookie.optString("guid", "1000000001"), uin = cookie.optString("uin", cookie.optString("qqmusic_uin", "0")), key = cookie.optString("qm_keyst", cookie.optString("qqmusic_key", ""));
        switch (action) {
            case "search": module = "music.search.SearchCgiService"; method = "DoSearchForQQMusicMobile"; payload = object("query", query, "search_type", 0, "num_per_page", 20, "page_num", page, "search_id", Long.toString(System.currentTimeMillis()), "highlight", 0); break;
            case "login-create": module = "music.login.LoginServer"; method = "CreateQRCode"; payload = object("tmeAppID", "qqmusic"); break;
            case "login-check": module = "music.login.LoginServer"; method = "CheckQRCode"; payload = object("qrcodeID", data.getString("key"), "tmeAppID", "qqmusic"); break;
            case "session": module = "music.UserInfo.userInfoServer"; method = "GetLoginUserInfo"; payload = object(); break;
            case "detail": module = "music.pf_song_detail_svr"; method = "get_song_detail_yqq"; payload = object("song_mid", id); break;
            case "playback": case "download": module = "vkey.GetVkeyServer"; method = "CgiGetVkey"; payload = object("guid", guid, "songmid", new JSONArray().put(id), "songtype", new JSONArray().put(0), "uin", uin, "loginflag", key.isEmpty() ? 0 : 1, "platform", "20"); break;
            default: throw new Exception("不支持此音乐操作");
        }
        boolean mobile = action.equals("login-create") || action.equals("login-check") || action.equals("session");
        JSONObject comm = mobile ? object("ct", 11, "cv", 20090008, "v", 20090008, "chid", "10003505", "tmeAppID", "qqmusic", "guid", guid) : object("ct", 19, "cv", 2201, "guid", guid, "uin", uin.matches("[0-9]{1,16}") ? Long.parseLong(uin) : 0, "authst", key);
        if (mobile && !uin.equals("0")) comm.put("qq", uin); if (mobile && !key.isEmpty()) comm.put("authst", key);
        return new Request("https://u.y.qq.com/cgi-bin/musicu.fcg", object("comm", comm, "req_0", object("module", module, "method", method, "param", payload)).toString(), "https://y.qq.com/", mobile);
    }
}
