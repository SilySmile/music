package com.tingyu.music;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** Bounded MQTT 5 wire messages for QQ Music login only. */
final class ProviderMqtt {
    static byte[] join(byte[]... values) { ByteArrayOutputStream out = new ByteArrayOutputStream(); for (byte[] value : values) out.write(value, 0, value.length); return out.toByteArray(); }
    static byte[] number(int value) { ByteArrayOutputStream out = new ByteArrayOutputStream(); do { int digit = value % 128; value /= 128; out.write(digit | (value > 0 ? 128 : 0)); } while (value > 0); return out.toByteArray(); }
    static byte[] text(String value) { byte[] bytes = value.getBytes(StandardCharsets.UTF_8); return join(new byte[] {(byte)(bytes.length >> 8), (byte)bytes.length}, bytes); }
    static byte[] property(String key, String value) { return join(new byte[] {38}, text(key), text(value)); }
    static byte[] packet(int type, byte[] body) { return join(new byte[] {(byte)type}, number(body.length), body); }
    static byte[] connect(String key) {
        byte[] props = join(new byte[] {21}, text("pass"), property("tmeAppID", "qqmusic"), property("business", "management"), property("hashTag", key), property("clientTag", "management.user"), property("userID", key));
        return packet(16, join(text("MQTT"), new byte[] {5, 2, 0, 30}, number(props.length), props, text(Long.toString(System.currentTimeMillis()) + "1234")));
    }
    static byte[] subscribe(String key) { byte[] props = join(property("authorization", "tmelogin"), property("pubsub", "unicast")); return packet(130, join(new byte[] {0, 1}, number(props.length), props, text("management.qrcode_login/" + key), new byte[] {1})); }
    static final class Reader {
        final byte[] bytes; int offset;
        Reader(byte[] bytes) { this.bytes = bytes; }
        byte[] read(int length) throws Exception { if (length < 0 || offset + length > bytes.length) throw new Exception("登录消息不完整"); byte[] out = java.util.Arrays.copyOfRange(bytes, offset, offset + length); offset += length; return out; }
        int one() throws Exception { return read(1)[0] & 255; }
        int two() throws Exception { return (one() << 8) | one(); }
        int number() throws Exception { int value = 0, factor = 1; for (int i = 0; i < 4; i++) { int digit = one(); value += (digit & 127) * factor; if ((digit & 128) == 0) return value; factor *= 128; } throw new Exception("登录消息长度无效"); }
        String text() throws Exception { return new String(read(two()), StandardCharsets.UTF_8); }
        Map<String, String> properties() throws Exception {
            int length = number(), end = offset + length; Map<String, String> result = new HashMap<>(); if (end > bytes.length) throw new Exception("登录属性不完整");
            while (offset < end) { int id = one(); switch (id) {
                case 38: result.put(text(), text()); break;
                case 3: case 8: case 18: case 21: case 26: case 28: case 31: result.put(Integer.toString(id), text()); break;
                case 1: case 23: case 25: case 36: case 37: case 40: case 41: case 42: read(1); break;
                case 19: case 33: case 34: case 35: read(2); break;
                case 2: case 17: case 24: case 39: read(4); break;
                case 9: case 22: read(two()); break;
                case 11: number(); break;
                default: throw new Exception("不支持的登录消息属性");
            } }
            if (offset != end) throw new Exception("登录属性长度无效"); return result;
        }
        byte[] rest() { return java.util.Arrays.copyOfRange(bytes, offset, bytes.length); }
    }
}
