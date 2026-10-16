package com.tingyu.music;

import org.junit.Test;
import static org.junit.Assert.*;

public class CloudAudioSourceTest {
    @Test public void acceptsOnlyCleanHttpsStreamingForTheMatchingSong() throws Exception {
        String id = "a".repeat(64);
        String valid = "https://example.test/music-library/tracks/" + id + "/stream/audio";
        assertEquals(valid, CloudAudioSource.validate(id, valid));
        for (String invalid : new String[] { valid.replace("https:", "http:"), valid + "?token=secret", valid + "#fragment", valid.replace("example.test", "user:secret@example.test"), valid.replace(id, "b".repeat(64)) }) {
            try { CloudAudioSource.validate(id, invalid); fail("Invalid address accepted"); } catch (Exception expected) { assertNotNull(expected.getMessage()); }
        }
    }
}
