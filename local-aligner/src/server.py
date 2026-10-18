"""Local audio+reference-text API using native Windows CUDA Transformers."""
import argparse
import asyncio
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import gc
import hmac
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid

from core import decode_scored_predictions, pressure_reason, validate_manifest


class TransformersBackend:
    def __init__(self, config):
        import torch
        from qwen_asr import Qwen3ForcedAligner
        if not torch.cuda.is_available():
            raise RuntimeError("未检测到 CUDA，请运行首次准备并检查 NVIDIA 驱动")
        torch.set_num_threads(config.get("cpu_threads", 4))
        torch.set_num_interop_threads(2)
        free, total = torch.cuda.mem_get_info(0)
        self.memory_fraction = min(config.get("gpu_memory_utilization", .45), (free - config.get("min_free_gpu_mb", 1536) * 1048576) / total)
        if self.memory_fraction < .30:
            raise RuntimeError("当前空闲显存不足以加载模型并为桌面保留余量，请关闭其他 GPU 软件")
        torch.cuda.set_per_process_memory_fraction(self.memory_fraction, 0)
        print(f"CUDA 分配器预算：{self.memory_fraction:.1%}，为桌面保留显存", flush=True)
        self.config = config
        self.aligner = Qwen3ForcedAligner.from_pretrained(
            config["model_path"], dtype=torch.bfloat16, device_map="cuda:0",
            attn_implementation="sdpa", local_files_only=True, use_safetensors=True,
        )
        self.aligner.model.eval()
        self.segment_ms = self.aligner.timestamp_segment_time

    def align(self, jobs):
        import torch
        texts = []
        for job in jobs:
            body = "".join(unit + "<timestamp><timestamp>" for unit in job["line"]["units"])
            texts.append("<|audio_start|><|audio_pad|><|audio_end|>" + body)
        # Keep the player's original units and raw predictions. The official
        # convenience align() normalizes text and repairs some invalid times;
        # neither is suitable for strict source preservation and gap validation.
        with torch.inference_mode():
            inputs = self.aligner.processor(text=texts, audio=[job["audio"] for job in jobs], return_tensors="pt", padding=True)
            inputs = inputs.to(self.aligner.model.device).to(self.aligner.model.dtype)
            logits = self.aligner.model.thinker(**inputs).logits
            predictions = [output[input_id == self.aligner.timestamp_token_id].float().cpu().numpy() for input_id, output in zip(inputs["input_ids"], logits)]
        results = []
        for job, scores in zip(jobs, predictions):
            line = job["line"]
            try:
                bins = scores.argmax(axis=-1).tolist()
                words, calibrated = decode_scored_predictions(line["units"], scores, bins, self.segment_ms, job.get("offset", line["start"]), job["end"], line["start"])
                results.append({"id": line["id"], "text": line["text"], "words": words, "calibrated": calibrated})
            except ValueError as error:
                results.append({"id": line["id"], "text": line["text"], "error": str(error)})
        if len(results) != len(jobs):
            raise RuntimeError("模型未返回完整批次")
        return results


def resource_status(config):
    import psutil
    try:
        raw = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.free,temperature.gpu", "--format=csv,noheader,nounits"], timeout=3, text=True, **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {})).splitlines()[0]
        free, temperature = map(float, raw.split(","))
        return pressure_reason(config, psutil.virtual_memory().available / 1048576, psutil.cpu_percent(interval=.1), free, temperature)
    except (OSError, ValueError, subprocess.SubprocessError):
        return "无法读取显卡资源，暂停接新任务"


class ResourceMonitor:
    """Share one recent host/GPU sample across batches and health requests."""
    def __init__(self, config, sample=None, clock=time.monotonic):
        self.sample = sample or (lambda: resource_status(config))
        self.clock = clock
        self.next_sample = float('-inf')
        self.reason = ''
        self.lock = threading.Lock()

    def __call__(self):
        with self.lock:
            if self.clock() >= self.next_sample:
                self.reason = self.sample()
                self.next_sample = self.clock() + 1
            return self.reason


def read_audio(file, config):
    import numpy as np
    from imageio_ffmpeg import get_ffmpeg_exe
    limit = config.get("max_track_seconds", 1200)
    # A bounded extra second detects overlong input without a separate ffprobe
    # installation. The bundled Windows ffmpeg stays inside the private env.
    result = subprocess.run([get_ffmpeg_exe(), "-nostdin", "-v", "error", "-threads", "2", "-i", str(file), "-t", str(limit + 1), "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], capture_output=True, timeout=90, check=True, **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    audio = np.frombuffer(result.stdout, dtype=np.float32)
    if not 0 < len(audio) <= limit * 16000:
        raise ValueError("音频为空或歌曲超过 20 分钟，请拆分长录音")
    return audio


def create_app(config, backend, monitor=None, idle_callback=None):
    from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
    from fastapi.responses import JSONResponse
    # FastAPI resolves annotations from module globals.
    globals().update(Request=Request, UploadFile=UploadFile)
    monitor = monitor or ResourceMonitor(config)
    queue = asyncio.Queue(maxsize=16)
    slots = asyncio.Semaphore(max(1, min(2, config.get("max_concurrency", 2))))
    decoder = asyncio.Semaphore(1)
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bounded-aligner")
    state = {"active": 0, "last_used": time.monotonic(), "fatal": "", "pressure": "", "batch_size": max(1, min(2, config.get("max_batch_size", 2)))}
    progress = {}

    async def worker():
        while True:
            first = await queue.get()
            jobs = [first]
            if queue.empty():
                await asyncio.sleep(.005)
            while len(jobs) < state["batch_size"] and not queue.empty():
                jobs.append(queue.get_nowait())
            live = [job for job in jobs if not job["future"].cancelled()]
            try:
                reason = await asyncio.to_thread(monitor)
                deadline = time.monotonic() + 30
                while reason and time.monotonic() < deadline and any(not job["future"].cancelled() for job in live):
                    await asyncio.sleep(1)
                    reason = await asyncio.to_thread(monitor)
                state["pressure"] = reason
                if reason or state["fatal"]:
                    raise RuntimeError(reason or state["fatal"])
                if live:
                    results = await asyncio.get_running_loop().run_in_executor(executor, backend.align, live)
                    for job, value in zip(live, results):
                        if not job["future"].done():
                            job["future"].set_result(value)
            except Exception as error:
                message = str(error)
                if "out of memory" in message.lower() or "engine" in message.lower() and "dead" in message.lower():
                    state["fatal"] = "显存不足或推理引擎停止，请关闭其他 GPU 软件后重新启动模型"
                    state["batch_size"] = 1
                for job in live:
                    if not job["future"].done():
                        job["future"].set_exception(RuntimeError(state["fatal"] or message))
            finally:
                for job in jobs:
                    job.pop("audio", None)
                    queue.task_done()

    async def idle_watch():
        while True:
            await asyncio.sleep(10)
            if idle_callback and not state["active"] and queue.empty() and time.monotonic() - state["last_used"] > config.get("idle_exit_seconds", 600):
                idle_callback()
                return

    @asynccontextmanager
    async def lifespan(_app):
        tasks = [asyncio.create_task(worker()), asyncio.create_task(idle_watch())]
        yield
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied.encode(), ("Bearer " + config["api_key"]).encode()):
            return JSONResponse({"error": "本地服务密钥不匹配"}, status_code=401)
        if request.method == "POST":
            try:
                if not 0 < int(request.headers.get("content-length", "0")) <= 26 * 1024 * 1024:
                    raise ValueError()
            except ValueError:
                return JSONResponse({"error": "上传需携带长度且不得超过 26 MB"}, status_code=413)
        return await call_next(request)

    @app.get("/v1/health")
    async def health():
        reason = state["fatal"] or await asyncio.to_thread(monitor)
        return {"service": "xianqiji-forced-aligner", "protocol": 1, "model": config["model_name"], "ready": not bool(state["fatal"]), "resource_ready": not bool(reason), "reason": reason, "concurrency": max(1, min(2, config.get("max_concurrency", 2))), "active": state["active"], "progress": list(progress.values()), "alignment_strategies": 5}

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": config["model_name"], "object": "model"}]}

    @app.post("/v1/shutdown")
    async def shutdown():
        if idle_callback:
            idle_callback()
        return {"stopping": True}

    @app.post("/v1/alignments")
    async def align(request: Request, file: UploadFile = File(...), model: str = Form(...), alignment: str = Form(...)):
        if slots.locked():
            raise HTTPException(429, "本地对齐队列已满，请稍后重试")
        if model != config["model_name"] or len(alignment) > 200000:
            raise HTTPException(400, "模型或歌词参数无效")
        try:
            manifest = json.loads(alignment)
            lines = validate_manifest(manifest, model)
        except (ValueError, TypeError) as error:
            raise HTTPException(400, str(error)) from error
        reason = state["fatal"] or await asyncio.to_thread(monitor)
        if reason:
            raise HTTPException(503, reason)
        futures = []
        async with slots:
            request_id = uuid.uuid4().hex
            current = {"trackId": manifest["trackId"], "total": len(lines), "processed": 0, "matched": 0}
            progress[request_id] = current
            state["active"] += 1
            state["last_used"] = time.monotonic()
            try:
                with tempfile.TemporaryDirectory(prefix="request-", dir=config.get("temp_dir")) as directory:
                    source = Path(directory) / "audio.bin"
                    size = 0
                    with source.open("wb") as output:
                        while chunk := await file.read(1024 * 1024):
                            size += len(chunk)
                            if size > 24 * 1024 * 1024:
                                raise HTTPException(413, "音频超过 24 MB")
                            output.write(chunk)
                    async with decoder:
                        audio = await asyncio.to_thread(read_audio, source, config)
                    source.unlink()
                    duration = len(audio) / 16000
                    results = []
                    # Keep at most two phrase arrays alive per request, not a
                    # whole library worth of decoded audio or GPU requests.
                    for offset in range(0, len(lines), 2):
                        futures = []
                        if await request.is_disconnected():
                            raise asyncio.CancelledError()
                        for line in lines[offset:offset + 2]:
                            end = min(duration, line["end"])
                            if end <= line["start"] or end - line["start"] > config.get("max_segment_seconds", 60):
                                results.append({"id": line["id"], "text": line["text"], "error": "本句区间超过 60 秒或超出音频，请设置本句唱完时间后重试"})
                                continue
                            future = asyncio.get_running_loop().create_future()
                            # A new prefix changes the acoustic context and the
                            # timestamp grid; accepted words remain inside the
                            # unchanged source phrase. Never pad a word to fill
                            # an instrumental break or relax score thresholds.
                            contexts = (0, .12, .30, .58, 1.10)
                            attempt = manifest.get("attempt", 0)
                            context = contexts[attempt]
                            begin = max(0, line["start"] - context, end - config.get("max_segment_seconds", 60))
                            if any(abs(begin - max(0, line["start"] - prior, end - config.get("max_segment_seconds", 60))) < .00001 for prior in contexts[:attempt]):
                                results.append({"id": line["id"], "text": line["text"], "error": "已尝试相同音频范围，无法增加新上下文；请手动复核原句时间"})
                                continue
                            await queue.put({"line": line, "offset": begin, "end": end, "audio": audio[round(begin * 16000):round(end * 16000)], "future": future})
                            futures.append(future)
                        if futures:
                            group = asyncio.gather(*futures)
                            while not group.done():
                                await asyncio.wait([group], timeout=.25)
                                if await request.is_disconnected():
                                    group.cancel()
                                    raise asyncio.CancelledError()
                            results.extend(await group)
                        current["processed"] = len(results)
                        current["matched"] = sum("words" in result and not result.get("error") for result in results)
                    return {"protocol": 1, "model": model, "trackId": manifest["trackId"], "lines": sorted(results, key=lambda line: line["id"])}
            except (ValueError, subprocess.SubprocessError) as error:
                raise HTTPException(422, "音频解码或歌词时间无效") from error
            except RuntimeError as error:
                raise HTTPException(503, str(error)) from error
            finally:
                for future in futures:
                    if not future.done():
                        future.cancel()
                await file.close()
                progress.pop(request_id, None)
                state["active"] -= 1
                state["last_used"] = time.monotonic()
                gc.collect()
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--instance", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    if not isinstance(config.get("api_key"), str) or len(config["api_key"]) < 16:
        raise SystemExit("请先运行首次准备，生成本地密钥")
    if not .30 <= config.get("gpu_memory_utilization", .45) <= .65:
        raise SystemExit("显存占用比例须在 0.30–0.65 之间")
    from windows_runtime import owned_runtime
    with owned_runtime(args.config, args.instance, config):
        import uvicorn
        backend = TransformersBackend(config)
        print("CUDA 模型已加载，启动本机强对齐接口", flush=True)
        server = uvicorn.Server(uvicorn.Config(create_app(config, backend, idle_callback=lambda: setattr(server, "should_exit", True)), host="127.0.0.1", port=config.get("port", 8765), access_log=False, workers=1, limit_concurrency=8))
        server.run()


if __name__ == "__main__":
    main()
