package com.tingyu.music;

import org.junit.Test;
import static org.junit.Assert.*;

public class LibraryPathsTest {
    @Test public void acceptsPortableLibraryIdsAndChineseFilenames() {
        assertEquals("song-1_2", LibraryPaths.id("song-1_2"));
        assertEquals("歌手 - 歌曲.zh.lrc", LibraryPaths.filename("歌手 - 歌曲.zh.lrc"));
    }
    @Test public void rejectsTraversalUrisAndControlCharacters() {
        for (String value : new String[] { "../audio.mp3", "..", ".", "C:\\secret", "content://private", "a\nb\nc", "", "a/b", "a\\b" }) {
            assertThrows(IllegalArgumentException.class, () -> LibraryPaths.filename(value));
        }
        for (String value : new String[] { "../song", "a/b", "a\\b", "", "歌曲", "song:id" }) assertThrows(IllegalArgumentException.class, () -> LibraryPaths.id(value));
    }
    @Test public void sanitizesFilenamesWithoutRenamingSongIdentity() {
        assertEquals("Artist _ Song_", LibraryPaths.safeName("Artist / Song? . "));
        assertEquals("歌曲", LibraryPaths.safeName("CON"));
        assertEquals("歌曲", LibraryPaths.safeName("..."));
        assertEquals(90, LibraryPaths.safeName("音".repeat(110)).length());
    }
}
