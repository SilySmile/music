#!/bin/bash
set -euo pipefail
umask 077
test "$(id -u)" = 0 || { echo 'Run with sudo or root.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
python3 -c 'import sys; assert sys.version_info >= (3, 6), "Python 3.6+ required"'
test -f /www/server/panel/vhost/nginx/xianqiji-updates.conf || { echo 'The existing HTTPS update site is required. Configure HTTPS/Nginx first; this installer never overwrites unrelated sites.' >&2; exit 1; }
test -x /www/server/nginx/sbin/nginx
staging=$(mktemp -d /root/xianqiji-library-install.XXXXXXXX)
cleanup() {
    case "$staging" in /root/xianqiji-library-install.*) rm -rf -- "$staging" ;; *) echo 'Unsafe temporary path; retained.' >&2 ;; esac
}
trap cleanup EXIT
for name in library-server.py library.service library-nginx-location.conf provision-library.sh; do
    install -m 600 "$source_dir/$name" "$staging/$name"
done
if [ -f /etc/xianqiji-library/auth.json ]; then
    install -m 600 /etc/xianqiji-library/auth.json "$staging/library-auth.json"
else
    python3 - "$staging" <<'PY'
import hashlib
import json
import os
import secrets
import sys

directory = sys.argv[1]
writer = secrets.token_urlsafe(32)
reader = secrets.token_urlsafe(32)
with open(os.path.join(directory, 'library-auth.json'), 'x') as stream:
    json.dump({'writers': [hashlib.sha256(writer.encode()).hexdigest()], 'readers': [hashlib.sha256(reader.encode()).hexdigest()]}, stream)
for name, token in [('owner', writer), ('reader', reader)]:
    filename = '/root/xianqiji-library-' + name + '.xqsource'
    with open(filename, 'x') as stream:
        json.dump({'format': 'xianqiji-source-connection', 'version': 1, 'baseUrl': 'https://39.106.55.218/music-library/', 'token': token}, stream)
    os.chmod(filename, 0o600)
PY
fi
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$staging/library-server.py"
bash "$staging/provision-library.sh" "$staging"
python3 - <<'PY'
import json
from urllib.error import HTTPError
from urllib.request import urlopen

try:
    urlopen('http://127.0.0.1:8765/info', timeout=10)
    raise SystemExit('Health check failed: unauthenticated access was accepted')
except HTTPError as error:
    if error.code != 401:
        raise
print('READY: HTTPS music-library route installed; existing data and access keys preserved.')
print('On a fresh install, privately copy /root/xianqiji-library-owner.xqsource to the app. Never share the owner file.')
PY
