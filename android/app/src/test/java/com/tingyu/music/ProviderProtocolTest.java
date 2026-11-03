package com.tingyu.music;

import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class ProviderProtocolTest {
    @Test public void buildsCurrentNetEaseQrProtocolAndMatchesDesktopVector() throws Exception {
        assertEquals("params=1CA81A97B7BAEB099F29A9B99A25CD6E58E7BA5B35F25231033065C776830C0A38A128CF8B3EAF44635E50E0B9800A4A037CBDA1E04BD460C02768E3ECD5E66E905A5BCAE52009FB0933EFB373A62E834048DEBDABCCC627F25820A8D94E0A8C", ProviderProtocol.eapi("/api/login/qrcode/unikey", new JSONObject().put("type", 3)));
        ProviderProtocol.Request request = ProviderProtocol.build("netease", "login-check", new JSONObject().put("key", "fixture"), new JSONObject().put("deviceId", "local-device").put("NMTID", "server-issued"));
        assertEquals("https://interfacepc.music.163.com/eapi/login/qrcode/client/login", request.url);
        assertTrue(request.cookieHeader.contains("deviceId=local-device")); assertTrue(request.cookieHeader.contains("NMTID=server-issued"));
        assertFalse(request.body.contains("fixture")); assertTrue(request.userAgent.contains("NeteaseMusicDesktop"));
    }
    @Test public void matchesTheDesktopEncryptionVector() throws Exception {
        String value = ProviderProtocol.weapi(new JSONObject().put("type", 3), "0123456789abcdef");
        assertEquals("params=UrX63R19WuqrzE6%2BnEgz1aUzJYXbECu0SH1CcCGpaPY%3D&encSecKey=35701388baf89fed412e11269b9c76625d095ecaf17f03fa018abe19ea2d38b949debf242ee39a71ca1f6cda71b1b86a45aa909ee27f7e78e267d34e732f0de948206c3340a788d0003372183e2f753c1f78b66ac23d134ac1fc9b993156520ea826b8aa89a962d4491b4b8d7e08738e1da9b07aa39bf4a7ef0b1c210728cd52", value);
    }
    @Test public void onlyBuildsSupportedReadAndLoginOperations() throws Exception {
        ProviderProtocol.Request qq = ProviderProtocol.build("qq", "search", new JSONObject().put("query", "歌曲"), new JSONObject());
        assertEquals("https://u.y.qq.com/cgi-bin/musicu.fcg", qq.url);
        assertEquals("歌曲", new JSONObject(qq.body).getJSONObject("req_0").getJSONObject("param").getString("query"));
        try { ProviderProtocol.build("qq", "delete-playlist", new JSONObject(), new JSONObject()); fail(); } catch (Exception expected) { assertNotNull(expected.getMessage()); }
        try { ProviderProtocol.build("netease", "playback", new JSONObject().put("id", "../cookie"), new JSONObject()); fail(); } catch (Exception expected) { assertNotNull(expected.getMessage()); }
    }
    @Test public void playbackAndDownloadsOnlyUseTheirOwnPlatformCdn() throws Exception {
        assertEquals("https://aqqmusic.tc.qq.com/a.m4a?vkey=x", ProviderMedia.validate("qq", "https://aqqmusic.tc.qq.com/a.m4a?vkey=x"));
        for (String invalid : new String[] { "https://music.126.net.attacker.example/a.mp3", "https://user:secret@m801.music.126.net/a.mp3", "http://m801.music.126.net/a.mp3", "https://ws.stream.qqmusic.qq.com/a.mp3" }) {
            try { ProviderMedia.validate("netease", invalid); fail(); } catch (Exception expected) { assertNotNull(expected.getMessage()); }
        }
    }
}
