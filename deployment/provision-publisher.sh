#!/bin/bash
set -euo pipefail
root=/srv/xianqiji-updates
if ! id xq-publish >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "$root/publisher" --shell /bin/bash xq-publish
fi
install -d -m 755 "$root/publisher" "$root/public/music-updates/releases"
install -d -m 700 "$root/publisher/.ssh" "$root/incoming" "$root/history"
chown xq-publish:www "$root/public/music-updates" "$root/public/music-updates/releases"
chown -R xq-publish:xq-publish "$root/publisher" "$root/incoming" "$root/history"
touch "$root/publish.lock"
chown xq-publish:xq-publish "$root/publish.lock"
chmod 600 "$root/publish.lock"
install -m 644 /root/xianqiji-deploy/publish-server.py /usr/local/libexec/xianqiji-publish.py
python3 -c 'import json; value=json.load(open("/root/xianqiji-deploy/public.json")); open("/etc/xianqiji-updates/update-public.pem","w").write(value["publicKey"])'
chmod 644 /etc/xianqiji-updates/update-public.pem
printf 'restrict,command="/usr/bin/python3 /usr/local/libexec/xianqiji-publish.py" %s\n' "$(cat /root/xianqiji-deploy/publisher_ed25519.pub)" > "$root/publisher/.ssh/authorized_keys"
chmod 600 "$root/publisher/.ssh/authorized_keys"
chown xq-publish:xq-publish "$root/publisher/.ssh/authorized_keys"
printf 'xianqiji updates healthy\n' > "$root/public/music-updates/health.txt"
chmod 644 "$root/public/music-updates/health.txt"
