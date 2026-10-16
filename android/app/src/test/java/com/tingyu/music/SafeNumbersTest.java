package com.tingyu.music;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

public class SafeNumbersTest {
    @Test
    public void acceptsJsonIntegerAndLargeZip64Offsets() {
        assertEquals(0L, SafeNumbers.fileOffset(Integer.valueOf(0)));
        assertEquals(4194304L, SafeNumbers.fileOffset(Integer.valueOf(4194304)));
        assertEquals(5368709120L, SafeNumbers.fileOffset(Long.valueOf(5368709120L)));
        assertEquals(5368709120L, SafeNumbers.fileOffset(Double.valueOf(5368709120d)));
    }

    @Test
    public void rejectsInvalidAndUnsafeOffsets() {
        for (Object value : new Object[] { null, "0", -1, 1.5, Double.NaN, Double.POSITIVE_INFINITY, 9007199254740992d }) {
            try { SafeNumbers.fileOffset(value); fail("Should reject " + value); }
            catch (IllegalArgumentException expected) { assertEquals("无效的文件偏移量", expected.getMessage()); }
        }
    }
}
