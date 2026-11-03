package com.tingyu.music;

import android.content.Context;
import java.net.URI;
import org.json.JSONObject;
import org.json.JSONArray;

public final class ProviderMedia {
    public static String validate(String provider, String value) throws Exception {
        URI uri = new URI(value); String host = uri.getHost(); boolean allowed = false;
        String[] suffixes = provider.equals("qq") ? new String[] { "qqmusic.qq.com", "music.qq.com", "aqqmusic.tc.qq.com" } : provider.equals("netease") ? new String[] { "music.126.net", "music.163.com" } : new String[0];
        if (host != null) for (String suffix : suffixes) if (host.equals(suffix) || host.endsWith("." + suffix)) allowed = true;
        if (!allowed || !"https".equals(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getRawFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw new Exception("音频地址不属于当前音乐平台");
        return uri.toString();
    }
    public static String resolve(Context context, String provider, String id) throws Exception {
        JSONObject response = ProviderApi.call(context, provider, "playback", new JSONObject().put("id", id), java.util.UUID.randomUUID().toString());
        String url;
        if (provider.equals("qq")) {
            JSONObject envelope = response.optJSONObject("req_0"); if (response.optInt("code", -1) != 0 || envelope == null || envelope.optInt("code", -1) != 0) throw new Exception("QQ 音乐拒绝了播放请求，请重新登录");
            JSONObject data = envelope.getJSONObject("data"); JSONObject item = data.getJSONArray("midurlinfo").getJSONObject(0); String part = item.optString("purl", ""); if (part.isEmpty()) throw new Exception("QQ 音乐未提供此歌曲音频，请检查账号权限");
            JSONArray bases = data.optJSONArray("sip"); String base = bases == null || bases.length() == 0 ? "https://isure.stream.qqmusic.qq.com/" : bases.getString(0); url = new URI(base.replaceFirst("^http:", "https:")).resolve(part).toString();
        } else {
            if (response.optInt("code", -1) != 200) throw new Exception("网易云音乐拒绝了播放请求，请重新登录");
            JSONObject item = response.getJSONArray("data").getJSONObject(0); url = item.optString("url", ""); if (url.isEmpty() || item.optInt("code", 200) != 200) throw new Exception("网易云未提供此歌曲音频，请检查账号权限");
        }
        return validate(provider, url.replaceFirst("^http:", "https:"));
    }
}
