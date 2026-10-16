package com.tingyu.music;

final class LibraryPaths {
    static String id(String value) {
        if (value == null || !value.matches("[a-zA-Z0-9_-]{1,128}")) throw new IllegalArgumentException("歌曲标识无效");
        return value;
    }

    static String filename(String value) {
        if (value == null || value.isEmpty() || value.equals(".") || value.equals("..") || value.indexOf('/') >= 0 || value.indexOf('\\') >= 0 || value.indexOf(':') >= 0 || value.chars().anyMatch(character -> character < 32)) throw new IllegalArgumentException("音乐库文件名无效");
        return value;
    }

    static String safeName(String value) {
        String result = value.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "_").replaceAll("[. ]+$", "").trim();
        if (result.length() > 90) result = result.substring(0, 90);
        if (result.isEmpty() || result.matches("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$")) return "歌曲";
        return result;
    }
}
