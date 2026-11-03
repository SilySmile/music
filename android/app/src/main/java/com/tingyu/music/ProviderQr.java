package com.tingyu.music;

import android.content.Context;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/** The official push channel reports QR confirmation and delivers the exchange token. */
final class ProviderQr {
    private static final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private static final OkHttpClient client = new OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build();
    private static final ScheduledExecutorService clock = Executors.newSingleThreadScheduledExecutor();
    static void clear() { for (Session session : sessions.values()) session.close(); sessions.clear(); }
    static JSONObject state(String key) throws Exception { Session session = sessions.get(key); if (session == null) return null; if (!session.error.isEmpty()) throw new Exception(session.error); return new JSONObject().put("code", 0).put("req_0", new JSONObject().put("code", 0).put("data", new JSONObject().put("code", session.code))); }
    static void begin(Context context, String key, String guid, int revision) throws Exception {
        clear(); Session session = new Session(context.getApplicationContext(), key, guid, revision); sessions.put(key, session); session.open("");
        if (!session.ready.await(15, TimeUnit.SECONDS) || !session.error.isEmpty()) { session.close(); sessions.remove(key); throw new Exception(session.error.isEmpty() ? "QQ 扫码实时连接超时，请刷新二维码" : session.error); }
    }
    private static final class Session {
        final Context context; final String key, guid; final int revision; final CountDownLatch ready = new CountDownLatch(1);
        volatile int code = 40000; volatile String error = ""; volatile boolean closed, exchanging; WebSocket socket; byte[] buffer = new byte[0]; int redirects; ScheduledFuture<?> ping, timeout;
        Session(Context context, String key, String guid, int revision) { this.context = context; this.key = key; this.guid = guid; this.revision = revision; }
        void send(byte[] bytes) { if (socket != null) socket.send(ByteString.of(bytes)); }
        void close() { closed = true; if (ping != null) ping.cancel(false); if (timeout != null) timeout.cancel(false); if (socket != null) { socket.send(ByteString.of((byte)224, (byte)0)); socket.close(1000, "done"); } }
        void fail(String message) { if (closed) return; error = message; ready.countDown(); close(); }
        void open(String suffix) {
            socket = client.newWebSocket(new Request.Builder().url("wss://mu.y.qq.com/ws/handshake" + suffix).header("Sec-WebSocket-Protocol", "mqtt").build(), new WebSocketListener() {
                @Override public void onOpen(WebSocket ws, Response response) { if (!closed) ws.send(ByteString.of(ProviderMqtt.connect(key))); }
                @Override public void onFailure(WebSocket ws, Throwable failure, Response response) { if (ws == socket) fail("QQ 扫码实时连接失败，请刷新二维码"); }
                @Override public void onClosed(WebSocket ws, int status, String reason) { if (ws == socket && !closed) fail("QQ 扫码实时连接已断开，请刷新二维码"); }
                @Override public void onMessage(WebSocket ws, ByteString bytes) { if (closed || ws != socket) return; try { receive(bytes.toByteArray()); } catch (Exception failure) { fail(failure.getMessage() == null ? "登录推送无效" : failure.getMessage()); } }
            });
        }
        synchronized void receive(byte[] bytes) throws Exception {
            buffer = ProviderMqtt.join(buffer, bytes); if (buffer.length > 256 * 1024) throw new Exception("登录推送过大");
            while (buffer.length > 1) {
                int length = 0, factor = 1, start = 1; boolean done = false;
                for (; start < buffer.length && start <= 4; start++) { int digit = buffer[start] & 255; length += (digit & 127) * factor; factor *= 128; if ((digit & 128) == 0) { start++; done = true; break; } }
                if (!done) { if (start > 4) throw new Exception("登录推送长度无效"); return; }
                if (length > 256 * 1024) throw new Exception("登录推送过大"); if (buffer.length < start + length) return;
                int header = buffer[0] & 255; ProviderMqtt.Reader input = new ProviderMqtt.Reader(java.util.Arrays.copyOfRange(buffer, start, start + length)); buffer = java.util.Arrays.copyOfRange(buffer, start + length, buffer.length);
                if ((header >> 4) == 2) {
                    input.one(); int reason = input.one(); Map<String, String> props = input.properties();
                    if ((reason == 156 || reason == 157) && props.containsKey("28") && redirects++ < 3) { WebSocket old = socket; socket = null; old.close(1000, "redirect"); buffer = new byte[0]; open("/" + java.net.URLEncoder.encode(props.get("28"), "UTF-8")); return; }
                    if (reason != 0) throw new Exception("QQ 登录实时通道拒绝连接（" + reason + "）"); send(ProviderMqtt.subscribe(key));
                } else if ((header >> 4) == 9) {
                    input.read(2); input.properties(); if (input.one() >= 128) throw new Exception("QQ 登录实时订阅失败"); ready.countDown();
                    ping = clock.scheduleAtFixedRate(() -> { if (!closed) send(new byte[] {(byte)192, 0}); }, 20, 20, TimeUnit.SECONDS);
                    timeout = clock.schedule(() -> { code = 40002; close(); }, 900, TimeUnit.SECONDS);
                } else if ((header >> 4) == 3) {
                    String topic = input.text(); int qos = (header >> 1) & 3; byte[] identifier = qos > 0 ? input.read(2) : null; Map<String, String> props = input.properties(); if (qos == 1) send(ProviderMqtt.packet(64, identifier));
                    if (!topic.equals("management.qrcode_login/" + key)) continue; String type = props.get("type");
                    if ("scanned".equals(type)) code = 40001;
                    else if ("timeout".equals(type) || "canceled".equals(type)) { code = 40002; close(); }
                    else if ("cookies".equals(type) && !exchanging) {
                        exchanging = true; code = 40001; JSONObject payload = new JSONObject(new String(input.rest(), StandardCharsets.UTF_8));
                        new Thread(() -> { try { ProviderApi.exchange(context, key, guid, revision, payload); if (!closed) { code = 0; close(); } } catch (Exception failure) { fail(failure.getMessage() == null ? "扫码确认失败" : failure.getMessage()); } }, "provider-login").start();
                    }
                }
            }
        }
    }
}
