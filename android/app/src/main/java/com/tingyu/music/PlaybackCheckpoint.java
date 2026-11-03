package com.tingyu.music;

import org.json.JSONObject;

/** A position belongs to one library, never to a playback URL or an account. */
public final class PlaybackCheckpoint {
    private PlaybackCheckpoint() {}

    public static JSONObject create(String scope, String id, double position, double duration) {
        JSONObject value = new JSONObject();
        if (scope == null || scope.isEmpty() || id == null || !id.matches("[a-f0-9]{64}") || !Double.isFinite(position) || position < 0 || !Double.isFinite(duration) || duration < 0) return value;
        try {
            value.put("scope", scope); value.put("id", id);
            value.put("position", duration > 0 ? Math.min(position, duration) : position);
            value.put("duration", duration);
        } catch (Exception ignored) {}
        return value;
    }

    public static JSONObject restore(String text, String scope) {
        try {
            JSONObject value = new JSONObject(text);
            if (scope == null || !scope.equals(value.optString("scope"))) return new JSONObject();
            return create(scope, value.getString("id"), value.getDouble("position"), value.getDouble("duration"));
        } catch (Exception ignored) { return new JSONObject(); }
    }
}
