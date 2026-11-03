package com.tingyu.music;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackCheckpointTest {
    private final String id = "a".repeat(64);

    @Test public void restoresBackgroundProgressFromSerializedNativeStorage() throws Exception {
        String beforeBackground = PlaybackCheckpoint.create("folder:phone", id, 12, 180).toString();
        String afterBackground = PlaybackCheckpoint.create("folder:phone", id, 92.75, 180).toString();
        assertEquals(12, PlaybackCheckpoint.restore(beforeBackground, "folder:phone").getDouble("position"), 0);
        assertEquals(92.75, PlaybackCheckpoint.restore(afterBackground, "folder:phone").getDouble("position"), 0);
        assertEquals(id, PlaybackCheckpoint.restore(afterBackground, "folder:phone").getString("id"));
    }

    @Test public void rejectsAnotherLibraryAndCorruptOrInvalidCheckpoints() {
        String saved = PlaybackCheckpoint.create("folder:first", id, 20, 180).toString();
        assertFalse(PlaybackCheckpoint.restore(saved, "folder:second").has("id"));
        assertFalse(PlaybackCheckpoint.restore("broken", "folder:first").has("id"));
        assertFalse(PlaybackCheckpoint.create("", id, 20, 180).has("id"));
        assertFalse(PlaybackCheckpoint.create("database", "bad-id", 20, 180).has("id"));
        for (double position : new double[] { -1, Double.NaN, Double.POSITIVE_INFINITY }) assertFalse(PlaybackCheckpoint.create("database", id, position, 180).has("id"));
        assertFalse(PlaybackCheckpoint.create("database", id, 20, -1).has("id"));
    }

    @Test public void clampsToDurationAndStoresNoMediaUrlOrCredentials() throws Exception {
        JSONObject saved = PlaybackCheckpoint.create("database", id, 200, 180);
        assertEquals(180, saved.getDouble("position"), 0);
        assertEquals(4, saved.length());
        assertFalse(saved.has("sourceUrl"));
        assertFalse(saved.has("token"));
    }
}
