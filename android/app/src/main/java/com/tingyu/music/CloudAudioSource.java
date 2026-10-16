package com.tingyu.music;

import java.net.URI;

public final class CloudAudioSource {
    public static String validate(String identifier, String value) throws Exception {
        URI uri = new URI(value);
        if (!identifier.matches("[a-f0-9]{64}") || !"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !uri.getPath().endsWith("/tracks/" + identifier + "/stream/audio")) throw new Exception("云端播放地址无效，请重新连接音源");
        return uri.toString();
    }
}
