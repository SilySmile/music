package com.tingyu.music;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class SourceDownloadWorkerTest {
    private static class Stop implements SourceDownloadWorker.Control {
        boolean stopped;
        @Override public void check() throws Exception { if (stopped) throw new Exception("pause"); }
        @Override public boolean paused() { return stopped; }
    }
    private static class Fixture implements SourceDownloadWorker.Transport, SourceDownloadWorker.Destination {
        final Map<String, byte[]> audio = new HashMap<>();
        final Map<String, ByteArrayOutputStream> pending = new HashMap<>();
        final Map<String, byte[]> library = new HashMap<>();
        final List<String> requests = new ArrayList<>();
        boolean corrupt;
        boolean failWrite;
        Stop stop;
        String pauseSong;
        String add(byte[] bytes) throws Exception { String identifier = SourceDownloadRules.digest(bytes); audio.put(identifier, bytes); return identifier; }
        @Override public JSONObject record(String identifier) throws Exception {
            requests.add(identifier);
            JSONObject metadata = new JSONObject().put("id", identifier).put("title", "歌曲").put("artist", "歌手").put("album", "专辑").put("format", "wav").put("duration", 20).put("lyrics", new JSONArray().put(new JSONObject().put("time", 0).put("text", "原文").put("translation", "中文")));
            return new JSONObject().put("metadata", metadata).put("audio", new JSONObject().put("size", audio.get(identifier).length).put("type", "audio/wav").put("sha256", identifier)).put("revision", 1);
        }
        @Override public byte[] chunk(String identifier, String kind, JSONObject media, long offset, int length) {
            byte[] bytes = java.util.Arrays.copyOfRange(audio.get(identifier), (int) offset, (int) offset + length);
            if (corrupt) bytes[0] ^= 1;
            if (identifier.equals(pauseSong)) stop.stopped = true;
            return bytes;
        }
        @Override public String begin(JSONObject remote) throws Exception { String identifier = remote.getJSONObject("metadata").getString("id"); pending.put(identifier, new ByteArrayOutputStream()); return identifier; }
        @Override public boolean needs(String upload, String kind) { return kind.equals("audio") && !library.containsKey(upload); }
        @Override public void write(String upload, String kind, long offset, byte[] bytes) throws Exception { if (failWrite) throw new Exception("目录授权失效"); assertEquals(offset, pending.get(upload).size()); pending.get(upload).write(bytes); }
        @Override public void finish(String upload, JSONObject hashes) throws Exception { if (!library.containsKey(upload)) { assertEquals(upload, hashes.getString("audio")); library.put(upload, pending.get(upload).toByteArray()); } pending.remove(upload); }
        @Override public void cancel(String upload) { pending.remove(upload); }
    }
    private JSONObject task(String... identifiers) throws Exception { return new JSONObject().put("ids", new JSONArray(identifiers)).put("completed", new JSONArray()); }
    @Test public void executesWholeQueueWithoutAnyPageOrJavascriptCallback() throws Exception {
        Fixture fixture = new Fixture(); byte[] large = new byte[3 * 1024 * 1024 + 19]; large[large.length - 1] = 42;
        String first = fixture.add(large); String second = fixture.add(new byte[] { 7, 8, 9 }); List<String> journal = new ArrayList<>(); List<String> notices = new ArrayList<>();
        JSONObject result = SourceDownloadWorker.run(task(first, second), fixture, fixture, new Stop(), value -> journal.add(value.toString()), notices::add);
        assertEquals("completed", result.getString("status")); assertEquals(2, result.getJSONArray("completed").length()); assertArrayEquals(large, fixture.library.get(first)); assertTrue(fixture.pending.isEmpty());
        assertTrue(journal.size() >= 4); assertTrue(notices.stream().anyMatch(value -> value.contains("66%"))); assertTrue(notices.get(notices.size() - 1).contains("2 / 2"));
    }
    @Test public void notificationPauseRetainsCompletedSongsAndResumeSkipsThem() throws Exception {
        Fixture fixture = new Fixture(); String first = fixture.add(new byte[] { 1, 2 }); String second = fixture.add(new byte[] { 3, 4 }); Stop stop = new Stop(); fixture.stop = stop; fixture.pauseSong = second;
        JSONObject paused = SourceDownloadWorker.run(task(first, second), fixture, fixture, stop, value -> {}, message -> {});
        assertEquals("paused", paused.getString("status")); assertEquals(first, paused.getJSONArray("completed").getString(0)); assertEquals(1, fixture.library.size()); assertTrue(fixture.pending.isEmpty());
        fixture.pauseSong = null; fixture.requests.clear();
        JSONObject resumed = SourceDownloadWorker.run(new JSONObject(paused.toString()), fixture, fixture, new Stop(), value -> {}, message -> {});
        assertEquals("completed", resumed.getString("status")); assertEquals(java.util.List.of(second), fixture.requests); assertEquals(2, fixture.library.size());
    }
    @Test public void corruptMediaAndLostDirectoryNeverCommitOrMarkComplete() throws Exception {
        for (boolean corrupt : new boolean[] { true, false }) {
            Fixture fixture = new Fixture(); String identifier = fixture.add(new byte[] { 5, 6, 7 }); fixture.corrupt = corrupt; fixture.failWrite = !corrupt;
            JSONObject result = SourceDownloadWorker.run(task(identifier), fixture, fixture, new Stop(), value -> {}, message -> {});
            assertEquals("failed", result.getString("status")); assertEquals(0, result.getJSONArray("completed").length()); assertTrue(fixture.library.isEmpty()); assertTrue(fixture.pending.isEmpty());
        }
    }
    @Test public void existingAudioSkipsMediaWhileMetadataCanBeSupplemented() throws Exception {
        Fixture fixture = new Fixture(); String identifier = fixture.add(new byte[] { 5, 6, 7 }); fixture.library.put(identifier, fixture.audio.get(identifier));
        JSONObject result = SourceDownloadWorker.run(task(identifier), fixture, fixture, new Stop(), value -> {}, message -> {}); assertEquals("completed", result.getString("status"));
        JSONObject original = fixture.record(identifier).getJSONObject("metadata"); original.put("favorite", true).put("addedAt", 123);
        original.getJSONArray("lyrics").getJSONObject(0).put("translation", "我的译文").put("endTime", 4);
        JSONObject remote = new JSONObject(original.toString()); remote.put("favorite", false).put("addedAt", 999); remote.getJSONArray("lyrics").getJSONObject(0).put("translation", "云端译文").put("endTime", 8).put("words", new JSONArray().put(new JSONObject().put("text", "原文").put("time", 0).put("endTime", 3))).put("wordTiming", "estimated");
        JSONObject merged = SourceDownloadRules.supplement(original, remote); JSONObject line = merged.getJSONArray("lyrics").getJSONObject(0);
        assertTrue(merged.getBoolean("favorite")); assertEquals(123, merged.getLong("addedAt")); assertEquals("我的译文", line.getString("translation")); assertEquals(4, line.getDouble("endTime"), 0); assertEquals(1, line.getJSONArray("words").length()); assertEquals("estimated", line.getString("wordTiming"));
        original.getJSONArray("lyrics").getJSONObject(0).remove("translation"); assertEquals("云端译文", SourceDownloadRules.supplement(original, remote).getJSONArray("lyrics").getJSONObject(0).getString("translation"));
    }
    @Test public void rejectsUntrustedAddressesAndMismatchedSongDescriptors() throws Exception {
        for (String address : new String[] { "http://example.com/library/", "https://key@example.com/library/", "https://example.com/library/?key=secret", "https://example.com/library/../" }) {
            try { SourceDownloadRules.baseUrl(address); fail(address); } catch (Exception expected) {}
        }
        assertEquals("https://example.com/library/", SourceDownloadRules.baseUrl("https://example.com/library/"));
        Fixture fixture = new Fixture(); String identifier = fixture.add(new byte[] { 1 }); JSONObject record = fixture.record(identifier); record.getJSONObject("audio").put("sha256", "0".repeat(64));
        try { SourceDownloadRules.validate(record, identifier); fail("mismatched hash"); } catch (Exception expected) {}
    }
    @Test public void nativeCheckpointsWhitelistFieldsAndNeverPersistKeysOrAudio() throws Exception {
        String identifier = "a".repeat(64); JSONObject supplied = task(identifier).put("id", "task-fixture").put("kind", "source").put("direction", "download").put("label", "下载").put("sourceIdentity", "b".repeat(64)).put("scope", "folder:fixture").put("libraryKey", "fixture").put("token", "PRIVATE-KEY-MUST-NOT-PERSIST").put("audio", "PRIVATE-AUDIO").put("baseUrl", "https://private.example/library/");
        JSONObject clean = NativeSourceDownloads.clean(supplied); assertTrue(clean.getBoolean("nativeDownload")); assertFalse(clean.toString().contains("PRIVATE")); assertFalse(clean.has("baseUrl")); assertEquals("folder:fixture", clean.getString("scope"));
        supplied.getJSONArray("completed").put("c".repeat(64)); try { NativeSourceDownloads.clean(supplied); fail("foreign checkpoint"); } catch (Exception expected) {}
    }
}
