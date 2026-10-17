#!/usr/bin/env bash
set -euo pipefail
root="$1"
venv=/opt/xianqiji-aligner/venv/bin/python
test -x "$venv" || { echo 'Run the first-time preparation first.'; exit 1; }
test -d /run/systemd/system || { echo 'systemd is not running. Finish first-time preparation, then restart this dedicated distribution.'; exit 1; }
if systemctl is-active --quiet xianqiji-aligner.service; then
    echo 'The dedicated model service is already starting/running.'
    exit 0
fi
mkdir -p "$root/runtime/logs" "$root/runtime/tmp"
# Keep the hidden Windows WSL client attached until the model exits: systemd
# services alone do not keep a WSL instance alive. No enable/autostart.
exec systemd-run --unit=xianqiji-aligner --collect --wait --service-type=exec \
  --property=MemoryMax=8G --property=CPUQuota=600% --property=Nice=10 \
  --property=OOMPolicy=stop --property=KillMode=control-group \
  --property="WorkingDirectory=$root/src" \
  --property="StandardOutput=append:$root/runtime/logs/server.log" \
  --property="StandardError=append:$root/runtime/logs/server.log" \
  --setenv=PATH=/opt/xianqiji-aligner/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/wsl/lib \
  --setenv="TMPDIR=$root/runtime/tmp" \
  --setenv=OMP_NUM_THREADS=4 --setenv=MKL_NUM_THREADS=4 \
  --setenv=TOKENIZERS_PARALLELISM=false --setenv=HF_HUB_OFFLINE=1 \
  --setenv=VLLM_WORKER_MULTIPROC_METHOD=spawn \
  --setenv=HF_HOME=/opt/xianqiji-aligner/cache/huggingface \
  --setenv=VLLM_CACHE_ROOT=/opt/xianqiji-aligner/cache/vllm \
  "$venv" "$root/src/server.py" --config "$root/runtime/service.json"
