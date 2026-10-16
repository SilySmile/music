package com.tingyu.music;

import org.junit.Test;
import static org.junit.Assert.*;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;

public class UpdateRulesTest {
    @Test public void normalizesCustomDomainsAndRejectsUnsafeUrls() throws Exception {
        assertEquals("https://updates.example.com/music-updates/", UpdateRules.baseUrl("updates.example.com"));
        assertEquals("https://updates.example.com/releases/", UpdateRules.baseUrl("https://updates.example.com/releases"));
        for (String value : new String[] { "http://updates.example.com", "https://user:pass@updates.example.com", "https://updates.example.com/?key=x", "file:///tmp/test" }) { try { UpdateRules.baseUrl(value); fail("unsafe URL accepted"); } catch (Exception expected) {} }
    }
    @Test public void comparesNumericVersionsAndConstrainsApkPaths() throws Exception {
        assertTrue(UpdateRules.compare("0.3.10", "0.3.9") > 0); assertEquals(0, UpdateRules.compare("1.0.0", "1.0.0"));
        assertEquals("https://new.example.com/music-updates/releases/v0.3.10/App.apk", UpdateRules.artifactUrl("new.example.com", "releases/v0.3.10/App.apk", "0.3.10"));
        try { UpdateRules.artifactUrl("new.example.com", "../App.apk", "0.3.10"); fail("path traversal accepted"); } catch (Exception expected) {}
    }
    @Test public void verifiesPublisherSignaturesAndRejectsTamperedBytes() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048); KeyPair pair = generator.generateKeyPair(); byte[] payload = "signed update".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(pair.getPrivate()); signer.update(payload); byte[] signature = signer.sign();
        assertTrue(UpdateRules.verify(pair.getPublic().getEncoded(), payload, signature)); payload[0] = 0; assertFalse(UpdateRules.verify(pair.getPublic().getEncoded(), payload, signature));
    }
}
