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
            raise ValueError("模型时间重叠、倒序、零时长或越界；原时间保留，请试听校准")
        words.append({"text": text, "start": start, "end": end})
        previous = end
    return words


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
