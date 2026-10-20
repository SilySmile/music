package com.tingyu.music;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PlaybackRulesTest {
    @Test public void naturallyAdvancesAndWrapsWithoutWebViewEvents() {
        assertEquals(1, PlaybackRules.next(0, 3, 1, "list", true, 0));
        assertEquals(0, PlaybackRules.next(2, 3, 1, "list", true, 0));
        assertEquals(2, PlaybackRules.next(0, 3, -1, "list", false, 0));
    }
    @Test public void repeatOneDoesNotBlockManualNext() {
        assertEquals(1, PlaybackRules.next(1, 3, 1, "one", true, 0));
        assertEquals(2, PlaybackRules.next(1, 3, 1, "one", false, 0));
    }
    @Test public void shuffleAvoidsImmediateRepeatsAndHandlesSingleTrack() {
        for (int index = 0; index < 3; index++) for (double random : new double[] { 0, 0.3, 0.999, 1 }) assertTrue(index != PlaybackRules.next(index, 3, 1, "shuffle", true, random));
        assertEquals(0, PlaybackRules.next(0, 1, 1, "shuffle", true, 0));
        assertEquals(-1, PlaybackRules.next(0, 0, 1, "list", true, 0));
    }
    @Test public void shuffleBagPlaysEverySongOncePerCycle() {
        java.util.List<Integer> bag = new java.util.ArrayList<>();
        java.util.Set<Integer> played = new java.util.HashSet<>();
        int index = 0;
        for (int step = 0; step < 3; step++) {
            index = PlaybackRules.nextShuffle(4, index, bag, 0.999);
            assertTrue(index != 0);
            assertTrue(played.add(index));
        }
        assertEquals(3, played.size());
        assertEquals(0, PlaybackRules.nextShuffle(1, 0, bag, 0.5));
        assertEquals(-1, PlaybackRules.nextShuffle(0, 0, bag, 0.5));
    }
    @Test public void sleepDeadlineCanStopImmediatelyOrWaitForTheCurrentSong() {
        assertFalse(PlaybackRules.sleepStop(100, 99, false, false, true));
        assertTrue(PlaybackRules.sleepStop(100, 100, false, false, true));
        assertFalse(PlaybackRules.sleepStop(100, 101, true, false, true));
        assertTrue(PlaybackRules.sleepStop(100, 101, true, true, true));
        assertTrue(PlaybackRules.sleepStop(100, 101, true, false, false));
        assertFalse(PlaybackRules.sleepStop(0, 101, false, true, true));
    }
}
