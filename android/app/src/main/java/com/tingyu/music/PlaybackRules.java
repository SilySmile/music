package com.tingyu.music;

public final class PlaybackRules {
    private PlaybackRules() {}

    public static int next(int index, int count, int direction, String mode, boolean ended, double random) {
        if (count <= 0) return -1;
        if (ended && "one".equals(mode)) return Math.max(0, Math.min(count - 1, index));
        if ("shuffle".equals(mode) && count > 1) return (index + 1 + Math.min(count - 2, (int) (Math.max(0, random) * (count - 1)))) % count;
        return (index + direction + count) % count;
    }

    public static boolean sleepStop(long deadline, long now, boolean finishTrack, boolean ended, boolean playing) {
        return deadline > 0 && now >= deadline && (!finishTrack || ended || !playing);
    }
}
