package com.tingyu.music;

import org.junit.Test;
import static org.junit.Assert.*;

public class LibraryRangeTest {
    @Test public void supportsFullSuffixAndSeekWithoutLoadingWholeAudio() {
        assertEquals(10, LibraryRange.parse(null, 10).length());
        assertFalse(LibraryRange.parse(null, 10).partial);
        assertEquals(3, LibraryRange.parse("bytes=2-4", 10).length());
        assertEquals(2, LibraryRange.parse("bytes=2-", 10).start);
        assertEquals(8, LibraryRange.parse("bytes=-2", 10).start);
        assertEquals(9, LibraryRange.parse("bytes=0-99", 10).end);
        assertEquals(0, LibraryRange.parse(null, 0).length());
    }
    @Test public void rejectsInvalidAndOverflowingRanges() {
        for (String header : new String[] { "bytes=10-", "bytes=4-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "bytes=9999999999999999999999-", "no-range" }) assertThrows(IllegalArgumentException.class, () -> LibraryRange.parse(header, 10));
        assertThrows(IllegalArgumentException.class, () -> LibraryRange.parse("bytes=0-", 0));
    }
}
