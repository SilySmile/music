"""Protocol validation and resource policy; no GPU packages needed to test."""
import math
import re


def linux_path(value):
    match = re.fullmatch(r"([A-Za-z]):[\\/](.*)", value)
    return f"/mnt/{match[1].lower()}/" + match[2].replace("\\", "/") if match else value


def validate_manifest(value, model):
    if not isinstance(value, dict) or not isinstance(value.get("trackId"), str) or len(value["trackId"]) > 128:
        raise ValueError("歌曲标识无效")
    lines = value.get("lines")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise ValueError("歌词行数须为 1–500")
    seen = set()
    for line in lines:
        if not isinstance(line, dict):
            raise ValueError("歌词格式无效")
        index, text, units = line.get("id"), line.get("text"), line.get("units")
        if type(index) is not int or index < 0 or index in seen or not isinstance(text, str) or len(text) > 6000:
            raise ValueError("歌词原文或行号无效")
        if not isinstance(units, list) or not 1 <= len(units) <= 256 or any(not isinstance(unit, str) or not unit or "<timestamp>" in unit or "<|" in unit for unit in units) or "".join(units) != text:
            raise ValueError("字词须完整保留原文且不包含模型控制标记")
        start, end = line.get("start"), line.get("end")
        if any(type(t) not in (int, float) or not math.isfinite(t) for t in (start, end)) or start < 0 or end <= start:
            raise ValueError("歌词时间范围无效")
        seen.add(index)
    return lines


def decode_predictions(units, bins, segment_ms, offset, boundary):
    if len(bins) != len(units) * 2:
        raise ValueError("模型时间标记数与原文不符")
    previous = offset
    words = []
    for index, text in enumerate(units):
        start = round(offset + bins[index * 2] * segment_ms / 1000, 3)
        end = round(offset + bins[index * 2 + 1] * segment_ms / 1000, 3)
        if not all(math.isfinite(t) for t in (start, end)) or start < previous or end <= start or end > boundary + .001:
            kind = "字词时间交叉" if start < previous else "零时长或倒序" if end <= start else "超出原句范围"
            raise ValueError(f"第 {index + 1} 字{kind}；请检查原句时间或歌词版本")
        words.append({"text": text, "start": start, "end": end})
        previous = end
    return words


def constrained_timestamps(scores, raw_bins, segment_ms, duration):
    """Viterbi over model logits, with positive word spans and no forced tail.

    A constrained time must remain within 0.8s and three logit units of that
    endpoint's own prediction. Reject low-scoring paths rather than allocating
    uniform words or forcing missing/incorrect lyrics onto silence.
    """
    import numpy as np
    values = np.asarray(scores, dtype=np.float32)
    if values.ndim != 2 or values.shape[0] != len(raw_bins) or len(raw_bins) % 2:
        raise ValueError("模型时间标记数与原文不符")
    if not values.shape[1] or not np.all(np.isfinite(values)):
        raise ValueError("模型未返回有效时间分数")
    count = min(values.shape[1], int(math.ceil(duration * 1000 / segment_ms)) + 1)
    if count < len(raw_bins) // 2 + 1:
        raise ValueError("原句区间太短，无法容纳当前字数")
    raw = np.asarray(raw_bins)
    if np.any(raw < 0) or np.any(raw >= values.shape[1]):
        raise ValueError("模型时间类别无效")
    peaks = values[np.arange(len(raw)), raw]
    local = values[:, :count] - peaks[:, None]
    allowed = (local >= -3) & (np.abs(np.arange(count)[None, :] - raw[:, None]) * segment_ms <= 800)
    local = np.where(allowed, local, -np.inf)
    previous = local[0].copy()
    parents = np.zeros((len(raw), count), dtype=np.int32)
    indices = np.arange(count)
    for row in range(1, len(raw)):
        prefix = np.maximum.accumulate(previous)
        new_best = previous > np.concatenate(([-np.inf], prefix[:-1]))
        argprefix = np.maximum.accumulate(np.where(new_best, indices, 0))
        if row % 2:  # end >= start + one model time bin; next start may equal end
            prefix = np.concatenate(([-np.inf], prefix[:-1]))
            argprefix = np.concatenate(([0], argprefix[:-1]))
        parents[row] = argprefix
        previous = local[row] + prefix
    last = int(np.argmax(previous))
    if not math.isfinite(float(previous[last])) or -float(previous[last]) / len(raw) > .8:
        raise ValueError("模型分数不足以确定可靠的逐字顺序；请检查原句时间或歌词版本")
    result = [last]
    for row in range(len(raw) - 1, 0, -1):
        last = int(parents[row, last]); result.append(last)
    return result[::-1]


def decode_scored_predictions(units, scores, raw_bins, segment_ms, offset, boundary):
    """Preserve valid argmax outputs; constrain ambiguous model scores on failure."""
    if not units or len(raw_bins) != 2 * len(units):
        raise ValueError("模型时间标记数与原文不符")
    try:
        return decode_predictions(units, raw_bins, segment_ms, offset, boundary), False
    except ValueError:
        bins = constrained_timestamps(scores, raw_bins, segment_ms, boundary - offset)
        # A final quantized bin may extend up to one bin beyond the audio cut.
        words = []
        previous = offset
        for index, text in enumerate(units):
            start = round(offset + bins[index * 2] * segment_ms / 1000, 3)
            end = round(min(boundary, offset + bins[index * 2 + 1] * segment_ms / 1000), 3)
            if start < previous or end <= start or end > boundary + .001:
                raise ValueError("模型无法在原句范围内确定有效字词时间")
            words.append(dict(text=text, start=start, end=end)); previous = end
        return words, True


def pressure_reason(config, memory_mb, cpu, gpu_free_mb, temperature):
    if memory_mb < config.get("min_available_memory_mb", 4096):
        return "可用内存不足，暂停接新任务"
    if cpu > config.get("max_cpu_percent", 85):
        return "CPU 繁忙，暂停接新任务"
    if gpu_free_mb < config.get("min_free_gpu_mb", 1536):
        return "空闲显存不足，暂停接新任务"
    if temperature >= config.get("max_gpu_temperature", 82):
        return "显卡温度偏高，暂停接新任务"
    return ""
