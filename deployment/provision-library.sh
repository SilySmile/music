#!/bin/bash
set -euo pipefail
source_dir=${1:?Pass uploaded deployment directory}
test -f "$source_dir/library-server.py"
test -f "$source_dir/library-auth.json"
test -f "$source_dir/library.service"
config=/www/server/panel/vhost/nginx/xianqiji-updates.conf
nginx=/www/server/nginx/sbin/nginx
test -f "$config"
if ! id xq-library >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /srv/xianqiji-library --shell /sbin/nologin xq-library
fi
install -d -m 700 -o xq-library -g xq-library /srv/xianqiji-library
install -d -m 750 -o root -g xq-library /etc/xianqiji-library
if [ ! -f /etc/xianqiji-library/auth.json ]; then
    install -m 640 -o root -g xq-library "$source_dir/library-auth.json" /etc/xianqiji-library/auth.json
else
    cmp /etc/xianqiji-library/auth.json "$source_dir/library-auth.json" >/dev/null || { echo 'Existing access keys differ; stopped without rotating keys.' >&2; exit 1; }
fi
install -m 644 -o root -g root "$source_dir/library-server.py" /usr/local/libexec/xianqiji-library.py
install -m 644 -o root -g root "$source_dir/library.service" /etc/systemd/system/xianqiji-library.service
install -m 644 -o root -g root "$source_dir/library-nginx-location.conf" /etc/xianqiji-library/nginx-location.conf
backup="$config.before-library-$(date +%Y%m%d%H%M%S)"
cp -p "$config" "$backup"
python3 - "$config" <<'PY'
import sys
filename = sys.argv[1]
with open(filename) as stream:
    content = stream.read()
include = '    include /etc/xianqiji-library/nginx-location.conf;\n'
if include not in content:
    anchor = '    location = /music-updates/manifest.json {'
    if content.count(anchor) != 1:
        raise SystemExit('Could not identify the existing HTTPS update server safely')
    content = content.replace(anchor, include + anchor)
    with open(filename, 'w') as stream:
        stream.write(content)
PY
if ! "$nginx" -t; then
    cp -p "$backup" "$config"
    echo 'Nginx configuration rejected and restored.' >&2
    exit 1
fi
systemctl daemon-reload
systemctl enable xianqiji-library.service
systemctl restart xianqiji-library.service
sleep 2
systemctl is-active --quiet xianqiji-library.service
"$nginx" -s reload
echo 'Private online library installed; update site and existing data preserved.'
