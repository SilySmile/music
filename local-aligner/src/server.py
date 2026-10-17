"""Local audio+reference-text API backed by bounded vLLM token classification."""
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
import time

from core import decode_predictions, linux_path, pressure_reason, validate_manifest


class VllmBackend:
    def __init__(self, config):
        import torch
        from vllm import LLM
        from vllm.config import PoolerConfig
        torch.set_num_threads(config.get("cpu_threads", 4))
        self.config = config
        self.engine = LLM(
            model=linux_path(config["model_path"]), runner="pooling", dtype="bfloat16",
            hf_overrides={"architectures": ["Qwen3ASRForcedAlignerForTokenClassification"]},
            pooler_config=PoolerConfig(task="token_classify", tok_pooling_type="STEP", step_tag_id=151705, use_activation=False),
            enforce_eager=True, gpu_memory_utilization=config.get("gpu_memory_utilization", .45),
            max_model_len=4096, max_num_batched_tokens=4096,
            max_num_seqs=max(1, min(2, config.get("max_batch_size", 2))), limit_mm_per_prompt={"audio": 1},
            enable_prefix_caching=False, max_parallel_loading_workers=1,
        )
        metadata = json.loads((Path(linux_path(config["model_path"])) / "config.json").read_text())
        self.segment_ms = metadata["timestamp_segment_time"]

    def align(self, jobs):
        inputs = []
        for job in jobs:
            body = "".join(unit + "<timestamp><timestamp>" for unit in job["line"]["units"])
            inputs.append({"prompt": "<|audio_start|><|audio_pad|><|audio_end|>" + body, "multi_modal_data": {"audio": (job["audio"], 16000)}})
        outputs = self.engine.encode(inputs, pooling_task="token_classify", use_tqdm=False)
        results = []
        for job, output in zip(jobs, outputs):
            line = job["line"]
            try:
                bins = output.outputs.data.argmax(dim=-1).tolist()
                words = decode_predictions(line["units"], bins, self.segment_ms, line["start"], job["end"])
                results.append({"id": line["id"], "text": line["text"], "words": words})
            except ValueError as error:
                results.append({"id": line["id"], "text": line["text"], "error": str(error)})
        if len(results) != len(jobs):
            raise RuntimeError("模型未返回完整批次")
        return results


def resource_status(config):
    import psutil
    try:
        raw = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.free,temperature.gpu", "--format=csv,noheader,nounits"], timeout=3, text=True).splitlines()[0]
        free, temperature = map(float, raw.split(","))
        return pressure_reason(config, psutil.virtual_memory().available / 1048576, psutil.cpu_percent(interval=.1), free, temperature)
    except (OSError, ValueError, subprocess.SubprocessError):
        return "无法读取显卡资源，暂停接新任务"


def read_audio(file, config):
    import numpy as np
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(file)], capture_output=True, text=True, timeout=15, check=True)
    duration = float(probe.stdout.strip())
    if not 0 < duration <= config.get("max_track_seconds", 1200):
        raise ValueError("歌曲过长：默认支持 20 分钟以内；请拆分长录音")
    # Both duration and decoded output are bounded before making numpy arrays.
    result = subprocess.run(["ffmpeg", "-v", "error", "-threads", "2", "-i", str(file), "-t", str(config.get("max_track_seconds", 1200)), "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], capture_output=True, timeout=90, check=True)
    return np.frombuffer(result.stdout, dtype=np.float32)


def create_app(config, backend, monitor=None, idle_callback=None):
    from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
    from fastapi.responses import JSONResponse
    # FastAPI resolves annotations from module globals.
    globals().update(Request=Request, UploadFile=UploadFile)
    monitor = monitor or (lambda: resource_status(config))
    queue = asyncio.Queue(maxsize=16)
    slots = asyncio.Semaphore(max(1, min(2, config.get("max_concurrency", 2))))
    decoder = asyncio.Semaphore(1)
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bounded-vllm")
    state = {"active": 0, "last_used": time.monotonic(), "fatal": "", "pressure": "", "batch_size": max(1, min(2, config.get("max_batch_size", 2)))}

    async def worker():
        while True:
            first = await queue.get()
            jobs = [first]
            await asyncio.sleep(.025)
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
        return {"service": "xianqiji-forced-aligner", "protocol": 1, "model": config["model_name"], "ready": not bool(state["fatal"]), "resource_ready": not bool(reason), "reason": reason, "concurrency": max(1, min(2, config.get("max_concurrency", 2))), "active": state["active"]}

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": config["model_name"], "object": "model"}]}

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
                            await queue.put({"line": line, "end": end, "audio": audio[round(line["start"] * 16000):round(end * 16000)], "future": future})
                            futures.append(future)
                        if futures:
                            group = asyncio.gather(*futures)
                            while not group.done():
                                await asyncio.wait([group], timeout=.25)
                                if await request.is_disconnected():
                                    group.cancel()
                                    raise asyncio.CancelledError()
                            results.extend(await group)
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
                state["active"] -= 1
                state["last_used"] = time.monotonic()
                gc.collect()
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    if not isinstance(config.get("api_key"), str) or len(config["api_key"]) < 16:
        raise SystemExit("请先运行首次准备，生成本地密钥")
    if not .2 <= config.get("gpu_memory_utilization", .45) <= .65:
        raise SystemExit("显存占用比例须在 0.2–0.65 之间")
    import uvicorn
    backend = VllmBackend(config)
    server = uvicorn.Server(uvicorn.Config(create_app(config, backend, idle_callback=lambda: setattr(server, "should_exit", True)), host="127.0.0.1", port=config.get("port", 8765), access_log=False, workers=1, limit_concurrency=8))
    server.run()


if __name__ == "__main__":
    main()
