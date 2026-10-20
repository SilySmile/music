package com.tingyu.music;

public final class PlaybackRules {
    private PlaybackRules() {}

    public static int next(int index, int count, int direction, String mode, boolean ended, double random) {
        if (count <= 0) return -1;
        if (ended && "one".equals(mode)) return Math.max(0, Math.min(count - 1, index));
        if ("shuffle".equals(mode) && count > 1) return (index + 1 + Math.min(count - 2, (int) (Math.max(0, random) * (count - 1)))) % count;
        return (index + direction + count) % count;
    }

    /**
     * Shuffle without repeats inside one cycle. The bag holds the indices still to play and is
     * refilled only when empty, so a small queue no longer keeps repeating the same few songs.
     */
    public static int nextShuffle(int count, int index, java.util.List<Integer> bag, double random) {
        if (count <= 0) return -1;
        if (count == 1) return 0;
        bag.removeIf(value -> value == null || value < 0 || value >= count || value == index);
        if (bag.isEmpty()) for (int candidate = 0; candidate < count; candidate++) if (candidate != index) bag.add(candidate);
        double fraction = Math.max(0, Math.min(0.999999, random));
        return bag.remove(Math.min(bag.size() - 1, (int) (fraction * bag.size())));
    }

    public static boolean sleepStop(long deadline, long now, boolean finishTrack, boolean ended, boolean playing) {
        return deadline > 0 && now >= deadline && (!finishTrack || ended || !playing);
    }
}
