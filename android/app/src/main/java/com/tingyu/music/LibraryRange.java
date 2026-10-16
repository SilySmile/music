package com.tingyu.music;

final class LibraryRange {
    final long start;
    final long end;
    final boolean partial;
    private LibraryRange(long start, long end, boolean partial) { this.start = start; this.end = end; this.partial = partial; }
    long length() { return Math.max(0, end - start + 1); }

    static LibraryRange parse(String header, long size) {
        if (size < 0) throw new IllegalArgumentException("Invalid size");
        if (header == null) return new LibraryRange(0, size - 1, false);
        if (size == 0 || !header.matches("bytes=[0-9]*-[0-9]*")) throw new IllegalArgumentException("Invalid range");
        String[] parts = header.substring(6).split("-", -1);
        long start; long end;
        if (parts[0].isEmpty()) {
            long suffix = Long.parseLong(parts[1]); if (suffix <= 0) throw new IllegalArgumentException("Invalid suffix");
            start = Math.max(0, size - suffix); end = size - 1;
        } else {
            start = Long.parseLong(parts[0]); end = parts[1].isEmpty() ? size - 1 : Math.min(size - 1, Long.parseLong(parts[1]));
        }
        if (start >= size || end < start) throw new IllegalArgumentException("Unsatisfiable range");
        return new LibraryRange(start, end, true);
    }
}
