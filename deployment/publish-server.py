import base64
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import subprocess

ROOT = "/srv/xianqiji-updates"
PUBLIC = os.path.join(ROOT, "public", "music-updates")
INCOMING = os.path.join(ROOT, "incoming")
HISTORY = os.path.join(ROOT, "history")


def checksum(filename):
    digest = hashlib.sha256()
    with open(filename, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{1,6}\.\d{1,6}\.\d{1,6}", value):
        raise ValueError("invalid version")
    return tuple(int(part) for part in value.split("."))


def verify(filename, allow_expired=False):
    with open(filename, "rb") as stream:
        content = stream.read(262145)
    if len(content) > 262144:
        raise ValueError("manifest too large")
    envelope = json.loads(content)
    if envelope.get("algorithm") != "RSA-SHA256":
        raise ValueError("unsupported signature")
    payload = base64.b64decode(envelope["payload"], validate=True)
    signature = base64.b64decode(envelope["signature"], validate=True)
    with tempfile.NamedTemporaryFile(prefix="signature-", dir=INCOMING) as signature_file:
        signature_file.write(signature)
        signature_file.flush()
        result = subprocess.run(["/usr/bin/openssl", "dgst", "-sha256", "-verify", "/etc/xianqiji-updates/update-public.pem", "-signature", signature_file.name], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            raise ValueError("manifest signature rejected")
    release = json.loads(payload)
    version(release["version"])
    now = datetime.datetime.utcnow()
    issued = datetime.datetime.strptime(release["issuedAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    expires = datetime.datetime.strptime(release["expiresAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    if release.get("product") != "xianqiji" or release.get("schema") != 1 or (expires <= now and not allow_expired) or issued > now + datetime.timedelta(days=1) or expires <= issued or expires - issued > datetime.timedelta(days=366):
        raise ValueError("invalid or expired release")
    if not isinstance(release.get("notes"), str) or len(release["notes"]) > 12000:
        raise ValueError("invalid release notes")
    return release


def publish():
    with open(os.path.join(ROOT, "publish.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        staging = tempfile.mkdtemp(prefix="publish-", dir=INCOMING)
        try:
            received = set()
            total = 0
            with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
                for member in archive:
                    name = member.name
                    if not member.isfile() or name in received or (name != "manifest.json" and not re.fullmatch(r"releases/v\d{1,6}\.\d{1,6}\.\d{1,6}/[A-Za-z0-9._-]+\.(exe|apk)", name)):
                        raise ValueError("unexpected archive entry")
                    total += member.size
                    if len(received) >= 8 or member.size < 0 or member.size > 4 * 1024 ** 3 or total > 10 * 1024 ** 3 or (name == "manifest.json" and member.size > 262144):
                        raise ValueError("archive size limit exceeded")
                    destination = os.path.join(staging, name)
                    os.makedirs(os.path.dirname(destination), exist_ok=True)
                    with archive.extractfile(member) as source, open(destination, "xb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                        output.flush()
                        os.fsync(output.fileno())
                    received.add(name)
            release = verify(os.path.join(staging, "manifest.json"))
            expected = {"manifest.json"}
            for platform, artifact in release["artifacts"].items():
                kinds = {"win-x64": "nsis", "win-x64-portable": "portable", "android": "apk"}
                extension = "apk" if platform == "android" else "exe"
                if kinds.get(platform) != artifact.get("kind") or not re.fullmatch(r"releases/v" + re.escape(release["version"]) + r"/[A-Za-z0-9._-]+\." + extension, artifact["file"]) or not re.fullmatch(r"[a-f0-9]{64}", artifact["sha256"]) or not isinstance(artifact["size"], int) or artifact["size"] <= 0:
                    raise ValueError("invalid artifact")
                filename = os.path.join(staging, artifact["file"])
                if os.path.getsize(filename) != artifact["size"] or checksum(filename) != artifact["sha256"]:
                    raise ValueError("artifact integrity check failed")
                expected.add(artifact["file"])
            if received != expected:
                raise ValueError("archive does not match signed manifest")
            current = os.path.join(PUBLIC, "manifest.json")
            previous = verify(current, allow_expired=True) if os.path.isfile(current) else None
            if previous and version(release["version"]) < version(previous["version"]):
                raise ValueError("refusing server rollback; publish a higher patch version")
            for artifact in release["artifacts"].values():
                destination = os.path.join(PUBLIC, artifact["file"])
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                os.chmod(os.path.dirname(destination), 0o755)
                if not os.path.realpath(destination).startswith(os.path.realpath(PUBLIC) + os.sep):
                    raise ValueError("destination escaped public root")
                if os.path.exists(destination):
                    if os.path.getsize(destination) != artifact["size"] or checksum(destination) != artifact["sha256"]:
                        raise ValueError("release paths are immutable; bump version")
                else:
                    os.replace(os.path.join(staging, artifact["file"]), destination)
                    os.chmod(destination, 0o644)
            if previous:
                stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%S%f")
                shutil.copyfile(current, os.path.join(HISTORY, "manifest-" + stamp + "-v" + previous["version"] + ".json"))
            os.chmod(os.path.join(staging, "manifest.json"), 0o644)
            os.replace(os.path.join(staging, "manifest.json"), current)
            print(json.dumps({"published": release["version"], "artifacts": len(release["artifacts"]), "manifest": "/music-updates/manifest.json"}))
        finally:
            if os.path.dirname(os.path.realpath(staging)) != os.path.realpath(INCOMING) or not os.path.basename(staging).startswith("publish-"):
                raise ValueError("unsafe staging cleanup")
            shutil.rmtree(staging)


try:
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if command == "status":
        release = verify(os.path.join(PUBLIC, "manifest.json"), allow_expired=True)
        print(json.dumps({"version": release["version"], "artifacts": list(release["artifacts"]), "expiresAt": release["expiresAt"]}))
    elif command == "publish":
        publish()
    else:
        raise ValueError("only publish and status commands are permitted")
except Exception as error:
    print("Publish rejected: " + str(error), file=sys.stderr)
    sys.exit(1)
