package com.tingyu.music;

import java.net.URI;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

public final class UpdateRules {
    private UpdateRules() {}
    public static String baseUrl(String value) throws Exception {
        if (value == null || value.trim().isEmpty() || value.length() > 2048 || value.matches(".*[\\s\\\\].*")) throw new Exception("请输入有效的 HTTPS 更新地址");
        String text = value.trim(); URI uri = new URI(text.contains("://") ? text : "https://" + text);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) throw new Exception("更新地址必须为不含密码、参数或片段的 HTTPS 地址");
        String path = uri.getPath(); if (path == null || path.isEmpty() || path.equals("/")) path = "/music-updates/"; else if (!path.endsWith("/")) path += "/";
        return new URI("https", null, uri.getHost().toLowerCase(java.util.Locale.ROOT), uri.getPort(), path, null, null).normalize().toASCIIString();
    }
    public static int compare(String left, String right) throws Exception {
        if (left == null || right == null || !left.matches("\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}") || !right.matches("\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}")) throw new Exception("无效的版本号");
        String[] first = left.split("\\."); String[] second = right.split("\\.");
        for (int index = 0; index < 3; index++) { int result = Integer.compare(Integer.parseInt(first[index]), Integer.parseInt(second[index])); if (result != 0) return result; }
        return 0;
    }
    public static boolean verify(byte[] publicKey, byte[] payload, byte[] signature) throws Exception {
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(publicKey))); verifier.update(payload); return verifier.verify(signature);
    }
    public static String artifactUrl(String base, String file, String version) throws Exception {
        compare(version, version);
        if (file == null || !file.matches("releases/v" + version.replace(".", "\\.") + "/[A-Za-z0-9._-]+\\.apk")) throw new Exception("更新包路径无效");
        URI root = new URI(baseUrl(base)); URI result = root.resolve(file);
        if (!root.getAuthority().equals(result.getAuthority()) || !result.getPath().startsWith(root.getPath())) throw new Exception("安装包超出更新服务器范围");
        return result.toASCIIString();
    }
}
