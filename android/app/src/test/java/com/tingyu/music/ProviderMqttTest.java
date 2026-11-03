package com.tingyu.music;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Map;

public class ProviderMqttTest {
    @Test public void connectsWithMqttFiveAndOfficialLoginProperties() throws Exception {
        byte[] packet = ProviderMqtt.connect("fixture-qr"); assertEquals(16, packet[0]); ProviderMqtt.Reader frame = new ProviderMqtt.Reader(java.util.Arrays.copyOfRange(packet, 1, packet.length)); assertEquals(frame.number(), frame.rest().length);
        ProviderMqtt.Reader input = new ProviderMqtt.Reader(frame.rest()); assertEquals("MQTT", input.text()); assertEquals(5, input.one()); assertEquals(2, input.one()); assertEquals(30, input.two()); Map<String, String> props = input.properties();
        assertEquals("pass", props.get("21")); assertEquals("fixture-qr", props.get("hashTag")); assertEquals("management.user", props.get("clientTag"));
    }
    @Test public void subscribesToOnlyTheMatchingQrTopic() throws Exception {
        byte[] packet = ProviderMqtt.subscribe("fixture-qr"); assertEquals(130, packet[0] & 255); ProviderMqtt.Reader frame = new ProviderMqtt.Reader(java.util.Arrays.copyOfRange(packet, 1, packet.length)); frame.number(); ProviderMqtt.Reader input = new ProviderMqtt.Reader(frame.rest()); input.read(2);
        assertEquals("tmelogin", input.properties().get("authorization")); assertEquals("management.qrcode_login/fixture-qr", input.text()); assertEquals(1, input.one());
    }
    @Test public void rejectsTruncatedAndUnrecognizedPropertyData() throws Exception {
        for (byte[] bytes : new byte[][] { {5, 38, 0}, {1, 127}, {(byte)255, (byte)255, (byte)255, (byte)255, 0} }) { try { new ProviderMqtt.Reader(bytes).properties(); fail(); } catch (Exception expected) { assertNotNull(expected.getMessage()); } }
    }
}
