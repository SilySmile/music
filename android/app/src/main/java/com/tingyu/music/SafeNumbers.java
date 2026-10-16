package com.tingyu.music;

public final class SafeNumbers {
    private SafeNumbers() {}

    public static long fileOffset(Object value) {
        if (!(value instanceof Number)) throw new IllegalArgumentException("无效的文件偏移量");
        double number = ((Number) value).doubleValue();
        if (Double.isNaN(number) || Double.isInfinite(number) || number < 0 || number > 9007199254740991d || number != Math.floor(number)) throw new IllegalArgumentException("无效的文件偏移量");
        return ((Number) value).longValue();
    }
}
