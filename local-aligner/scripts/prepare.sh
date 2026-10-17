#!/usr/bin/env bash
set -euo pipefail
root="$1"
export DEBIAN_FRONTEND=noninteractive
export TMPDIR="$root/runtime/tmp"
mkdir -p "$TMPDIR" "$root/runtime/logs"
apt-get update
apt-get install -y python3.12 python3.12-venv ffmpeg libsndfile1 systemd-sysv ca-certificates
# A private Linux virtualenv lives inside this distribution's E:-hosted VHD.
python3.12 -m venv /opt/xianqiji-aligner/venv
/opt/xianqiji-aligner/venv/bin/python -m pip install --upgrade pip
export PIP_CACHE_DIR=/opt/xianqiji-aligner/pip-cache
/opt/xianqiji-aligner/venv/bin/python -m pip install --only-binary=:all: -r "$root/requirements.txt"
/opt/xianqiji-aligner/venv/bin/python -c 'from vllm import LLM; from vllm.config import PoolerConfig; PoolerConfig(task="token_classify", tok_pooling_type="STEP", step_tag_id=151705, use_activation=False); import fastapi, psutil, multipart'
/opt/xianqiji-aligner/venv/bin/python -c 'import torch; assert torch.cuda.is_available(), "WSL CUDA unavailable: check the Windows NVIDIA driver and WSL2"; print("CUDA ready:", torch.cuda.get_device_name(0))'
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
printf 'Ready. No startup service has been enabled.\n'
