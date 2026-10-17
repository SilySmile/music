"""Own just this model process tree, with Windows resource limits and a mutex."""
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path


class BasicLimits(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                ("flags", wintypes.DWORD), ("minimum_working_set", ctypes.c_size_t),
                ("maximum_working_set", ctypes.c_size_t), ("active_process_limit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t), ("priority_class", wintypes.DWORD),
                ("scheduling_class", wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]


class CpuLimits(ctypes.Structure):
    _fields_ = [("flags", wintypes.DWORD), ("rate", wintypes.DWORD)]


_job_handles = []  # Closed by Windows on process exit, reaping decoder children.


def kernel_api():
    if os.name != "nt":
        raise RuntimeError("此启动方案需要 Windows 原生 Python")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    for name, args, result in (
        ("CreateMutexW", [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
        ("CreateJobObjectW", [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        ("SetInformationJobObject", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        ("AssignProcessToJobObject", [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        ("GetCurrentProcess", [], wintypes.HANDLE),
        ("SetPriorityClass", [wintypes.HANDLE, wintypes.DWORD], wintypes.BOOL),
        ("ReleaseMutex", [wintypes.HANDLE], wintypes.BOOL),
        ("CloseHandle", [wintypes.HANDLE], wintypes.BOOL),
    ):
        function = getattr(api, name)
        function.argtypes, function.restype = args, result
    return api


def apply_job_limits(api, config):
    job = api.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000 | 0x200  # kill descendants on close + job commit cap
        limits.job_memory = int(config.get("max_process_memory_mb", 8192)) * 1048576
        cpu = CpuLimits(0x1 | 0x4, max(1, min(10000, round(10000 * config.get("cpu_quota_cores", 6) / (os.cpu_count() or 1)))))
        for kind, value in ((9, limits), (15, cpu)):
            if not api.SetInformationJobObject(job, kind, ctypes.byref(value), ctypes.sizeof(value)):
                raise ctypes.WinError(ctypes.get_last_error())
        process = api.GetCurrentProcess()
        if not api.AssignProcessToJobObject(job, process):
            raise ctypes.WinError(ctypes.get_last_error())
        _job_handles.append(job)
        api.SetPriorityClass(process, 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
        return job
    except Exception:
        if job not in _job_handles:
            api.CloseHandle(job)
        raise


@contextmanager
def owned_runtime(config_file, instance, config):
    import psutil
    api = kernel_api()
    name = "Local\\XianqijiAligner-" + hashlib.sha256(str(Path(config_file).resolve()).lower().encode()).hexdigest()[:24]
    mutex = api.CreateMutexW(None, True, name)
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        api.CloseHandle(mutex)
        raise RuntimeError("模型已在启动或运行，不会重复加载")
    state_file = Path(config_file).parent / "service-process.json"
    try:
        apply_job_limits(api, config)
        state_file.write_text(json.dumps({"pid": os.getpid(), "created": psutil.Process().create_time(), "instance": instance}), encoding="utf-8")
        yield
    finally:
        try:
            if json.loads(state_file.read_text(encoding="utf-8"))["instance"] == instance:
                state_file.unlink()
        except (OSError, ValueError, KeyError):
            pass
        api.ReleaseMutex(mutex)
        api.CloseHandle(mutex)
