import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import math
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlsplit

CHUNK = 1024 * 1024
MAX_JSON = 2 * CHUNK
LOCK = threading.RLock()


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def require(condition, message, status=400):
    if not condition:
        raise ApiError(status, message)


def integer(value):
    require(isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991, "Invalid integer")
    return value


def digest(filename):
    value = hashlib.sha256()
    with open(filename, "rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            value.update(chunk)
    return value.hexdigest()


def metadata(value):
    require(isinstance(value, dict), "Invalid song metadata")
    require(isinstance(value.get("id"), str) and re.fullmatch(r"[a-f0-9]{64}", value["id"]), "Song ID must be audio SHA-256")
    for key in ("title", "artist", "album", "format"):
        require(isinstance(value.get(key), str) and len(value[key]) <= 2000, "Invalid " + key)
    require(isinstance(value.get("duration"), (int, float)) and not isinstance(value["duration"], bool) and 0 <= value["duration"] < 10000000, "Invalid duration")
    require(isinstance(value.get("lyrics"), list), "Invalid lyrics")
    for line in value["lyrics"]:
        require(isinstance(line, dict) and isinstance(line.get("text"), str) and isinstance(line.get("time"), (int, float)) and not isinstance(line["time"], bool) and -1 <= line["time"] < 10000000, "Invalid lyric line")
        require("translation" not in line or isinstance(line["translation"], str), "Invalid translation")
    for key in ("lyricsSource", "translationSource"):
        require(key not in value or isinstance(value[key], str), "Invalid lyric source")
    for key in ("addedAt", "lastPlayed", "onlineUpdatedAt"):
        if key in value:
            integer(value[key])
    require("favorite" not in value or isinstance(value["favorite"], bool), "Invalid favorite flag")
    if "translationAudit" in value:
        audit = value["translationAudit"]
        require(isinstance(audit, dict) and all(isinstance(audit.get(key), str) for key in ("song", "artist", "model")), "Invalid translation audit")
        integer(audit.get("verifiedAt"))
        integer(audit.get("checkedLines"))
    allowed = ("id", "title", "artist", "album", "duration", "format", "lyrics", "lyricsSource", "translationSource", "onlineUpdatedAt", "translationAudit", "favorite", "addedAt", "lastPlayed")
    clean = {key: value[key] for key in allowed if key in value}
    require(len(json.dumps(clean, ensure_ascii=False).encode("utf-8")) <= CHUNK, "Song metadata too large", 413)
    return clean


def descriptor(value):
    require(isinstance(value, dict) and isinstance(value.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "Invalid file digest")
    size = integer(value.get("size"))
    require(size > 0 and isinstance(value.get("type"), str) and len(value["type"]) <= 100, "Invalid media descriptor")
    return {"sha256": value["sha256"], "size": size, "type": value["type"]}


def supplement(existing, incoming):
    result = dict(incoming)
    if not result["lyrics"]:
        result["lyrics"] = existing.get("lyrics", [])
        for key in ("lyricsSource", "translationSource", "translationAudit"):
            if key in existing:
                result[key] = existing[key]
    else:
        translations = {(math.floor(line["time"] * 100 + 0.5), line["text"].strip()): line.get("translation") for line in existing.get("lyrics", [])}
        for line in result["lyrics"]:
            translation = translations.get((math.floor(line["time"] * 100 + 0.5), line["text"].strip()))
            if not line.get("translation") and translation:
                line["translation"] = translation
        if "translationSource" not in result and "translationSource" in existing:
            result["translationSource"] = existing["translationSource"]
    if not result["album"]:
        result["album"] = existing.get("album", "")
    return result


class Library:
    def __init__(self, directory, auth_file):
        self.directory = os.path.abspath(directory)
        self.auth_file = auth_file
        self.verified = {}
        for name in ("blobs", "uploads"):
            os.makedirs(os.path.join(self.directory, name), mode=0o700, exist_ok=True)
        with self.connection() as database:
            database.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS history (id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(id, revision));
                CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL);
            """)

    @contextmanager
    def connection(self):
        database = sqlite3.connect(os.path.join(self.directory, "library.sqlite3"), timeout=30)
        try:
            database.execute("PRAGMA synchronous=FULL")
            with database:
                yield database
        finally:
            database.close()

    def authorize(self, header, write=False):
        require(isinstance(header, str) and header.startswith("Bearer ") and 20 <= len(header[7:]) <= 1000, "Authentication required", 401)
        candidate = hashlib.sha256(header[7:].encode("utf-8")).hexdigest()
        with open(self.auth_file, encoding="utf-8") as stream:
            auth = json.load(stream)
        writer = any(hmac.compare_digest(candidate, value) for value in auth.get("writers", []))
        reader = writer or any(hmac.compare_digest(candidate, value) for value in auth.get("readers", []))
        require(reader, "Invalid access token", 401)
        require(not write or writer, "Read-only token cannot upload", 403)
        return writer

    def blob(self, sha256):
        require(isinstance(sha256, str) and re.fullmatch(r"[a-f0-9]{64}", sha256), "Invalid file digest")
        return os.path.join(self.directory, "blobs", sha256)

    def verify_media(self, media):
        filename = self.blob(media["sha256"])
        try:
            before = os.stat(filename)
            signature = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            if before.st_size != media["size"]:
                return False
            cached = self.verified.get(media["sha256"])
            if cached and cached[0] == signature:
                return cached[1]
            valid = digest(filename) == media["sha256"]
            after = os.stat(filename)
            if signature != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                return False
            if len(self.verified) >= 50000:
                self.verified.clear()
            self.verified[media["sha256"]] = (signature, valid)
            return valid
        except OSError:
            return False

    def track(self, identifier):
        require(re.fullmatch(r"[a-f0-9]{64}", identifier) is not None, "Invalid song ID")
        with self.connection() as database:
            row = database.execute("SELECT payload FROM tracks WHERE id=?", (identifier,)).fetchone()
        require(row is not None, "Song not found", 404)
        return json.loads(row[0])

    def upload(self, identifier, database):
        require(re.fullmatch(r"[a-f0-9]{32}", identifier) is not None, "Invalid upload ID")
        row = database.execute("SELECT payload FROM uploads WHERE id=?", (identifier,)).fetchone()
        require(row is not None, "Upload not found", 404)
        return json.loads(row[0])

    def save_upload(self, identifier, value, database):
        database.execute("UPDATE uploads SET payload=? WHERE id=?", (json.dumps(value, ensure_ascii=False), identifier))

    def revision(self, identifier, database):
        row = database.execute("SELECT revision FROM tracks WHERE id=?", (identifier,)).fetchone()
        return row[0] if row else 0

    def dispatch(self, method, route, query, body, writer):
        if method == "GET" and route == "/info":
            with self.connection() as database:
                count = database.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
            return {"product": "xianqiji-online-library", "schema": 1, "canWrite": writer, "trackCount": count, "chunkBytes": CHUNK, "verification": True}
        if method == "GET" and route == "/tracks":
            try:
                offset = integer(int(query.get("offset", ["0"])[0]))
            except ValueError:
                raise ApiError(400, "Invalid list offset")
            with self.connection() as database:
                rows = []
                size = 0
                for row in database.execute("SELECT payload FROM tracks ORDER BY id LIMIT 50 OFFSET ?", (offset,)):
                    length = len(row[0].encode("utf-8"))
                    if rows and size + length > 4 * CHUNK:
                        break
                    rows.append(row)
                    size += length
                total = database.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
            return {"tracks": [json.loads(row[0]) for row in rows], "next": offset + len(rows) if offset + len(rows) < total else None, "total": total}
        match = re.fullmatch(r"/tracks/([a-f0-9]{64})/verify", route)
        if method == "GET" and match:
            record = self.track(match.group(1))
            media = {kind: self.verify_media(record[kind]) for kind in ("audio", "cover") if kind in record}
            require(self.track(match.group(1))["revision"] == record["revision"], "Remote changed during verification", 409)
            return {"id": match.group(1), "revision": record["revision"], "ok": all(media.values()), "media": media}
        match = re.fullmatch(r"/tracks/([a-f0-9]{64})(?:/media/(audio|cover))?", route)
        if method == "GET" and match:
            record = self.track(match.group(1))
            if not match.group(2):
                return record
            kind = match.group(2)
            require(kind in record, "Media not found", 404)
            media = record[kind]
            try:
                offset = integer(int(query.get("offset", ["0"])[0]))
                length = integer(int(query.get("length", [str(CHUNK)])[0]))
            except ValueError:
                raise ApiError(400, "Invalid media range")
            require(0 < length <= CHUNK and offset < media["size"], "Invalid media range", 416)
            length = min(length, media["size"] - offset)
            with open(self.blob(media["sha256"]), "rb") as stream:
                stream.seek(offset)
                content = stream.read(length)
            require(len(content) == length, "Stored media is incomplete", 500)
            return {"data": base64.b64encode(content).decode("ascii"), "offset": offset, "size": media["size"], "sha256": media["sha256"]}
        require(writer, "Write permission required", 403)
        if method == "POST" and route == "/uploads":
            value = {"metadata": metadata(body.get("metadata")), "audio": descriptor(body.get("audio")), "offsets": {}}
            if body.get("cover") is not None:
                value["cover"] = descriptor(body["cover"])
            require(value["metadata"]["id"] == value["audio"]["sha256"], "Song ID does not match audio")
            value["expectedRevision"] = integer(body.get("expectedRevision"))
            with LOCK, self.connection() as database:
                require(self.revision(value["metadata"]["id"], database) == value["expectedRevision"], "Remote song changed; refresh and confirm again", 409)
                previous = database.execute("SELECT payload FROM tracks WHERE id=?", (value["metadata"]["id"],)).fetchone()
                if previous:
                    previous = json.loads(previous[0])
                    value["metadata"] = supplement(previous["metadata"], value["metadata"])
                    if "cover" not in value and "cover" in previous:
                        value["cover"] = previous["cover"]
                require(database.execute("SELECT COUNT(*) FROM uploads WHERE created>?", (int(time.time()) - 604800,)).fetchone()[0] < 1000, "Too many pending uploads", 429)
                identifier = uuid.uuid4().hex
                os.mkdir(os.path.join(self.directory, "uploads", identifier), 0o700)
                for kind in ("audio", "cover"):
                    if kind in value:
                        value["offsets"][kind] = value[kind]["size"] if self.verify_media(value[kind]) else 0
                database.execute("INSERT INTO uploads VALUES(?,?,?)", (identifier, json.dumps(value, ensure_ascii=False), int(time.time())))
            return {"id": identifier, "offsets": value["offsets"]}
        match = re.fullmatch(r"/uploads/([a-f0-9]{32})(?:/(chunk|finish))?", route)
        require(match is not None, "Endpoint not found", 404)
        identifier, operation = match.groups()
        with LOCK, self.connection() as database:
            value = self.upload(identifier, database)
            if method == "GET" and operation is None:
                return {"id": identifier, "offsets": value["offsets"], "done": value.get("done", False)}
            if method == "POST" and operation == "chunk":
                require(not value.get("done"), "Upload already committed", 409)
                kind = body.get("kind")
                require(kind in ("audio", "cover") and kind in value, "Invalid media kind")
                offset = integer(body.get("offset"))
                require(offset == value["offsets"][kind], "Chunk offset changed; query upload checkpoint", 409)
                require(isinstance(body.get("data"), str), "Invalid chunk")
                try:
                    content = base64.b64decode(body["data"], validate=True)
                except (ValueError, base64.binascii.Error):
                    raise ApiError(400, "Invalid base64 chunk")
                require(0 < len(content) <= CHUNK and offset + len(content) <= value[kind]["size"], "Chunk out of range")
                require(shutil.disk_usage(self.directory).free > len(content) + 256 * CHUNK, "Server disk space is low", 507)
                filename = os.path.join(self.directory, "uploads", identifier, kind)
                with open(filename, "r+b" if os.path.exists(filename) else "w+b") as stream:
                    require(os.fstat(stream.fileno()).st_size >= offset, "Upload file incomplete; start a new upload", 409)
                    stream.seek(offset)
                    stream.write(content)
                    stream.truncate()
                    stream.flush()
                    os.fsync(stream.fileno())
                value["offsets"][kind] = offset + len(content)
                self.save_upload(identifier, value, database)
                return {"offset": value["offsets"][kind]}
            require(method == "POST" and operation == "finish", "Endpoint not found", 404)
            if value.get("done"):
                return value["result"]
            database.execute("BEGIN IMMEDIATE")
            song_id = value["metadata"]["id"]
            require(self.revision(song_id, database) == value["expectedRevision"], "Remote song changed; refresh and confirm again", 409)
            record = {"metadata": value["metadata"], "revision": value["expectedRevision"] + 1, "updatedAt": int(time.time()) * 1000}
            for kind in ("audio", "cover"):
                if kind not in value:
                    continue
                media = value[kind]
                require(value["offsets"][kind] == media["size"], "Media upload incomplete", 409)
                staged = os.path.join(self.directory, "uploads", identifier, kind)
                filename = staged if os.path.isfile(staged) else self.blob(media["sha256"])
                require(os.path.getsize(filename) == media["size"] and digest(filename) == media["sha256"], "Media SHA-256 mismatch", 422)
                if filename == staged:
                    os.replace(staged, self.blob(media["sha256"]))
                record[kind] = media
            encoded = json.dumps(record, ensure_ascii=False, allow_nan=False)
            database.execute("INSERT OR REPLACE INTO tracks VALUES(?,?,?,?)", (song_id, record["revision"], encoded, record["updatedAt"]))
            database.execute("INSERT INTO history VALUES(?,?,?,?)", (song_id, record["revision"], encoded, record["updatedAt"]))
            value["done"] = True
            value["result"] = record
            self.save_upload(identifier, value, database)
            return record


class Handler(BaseHTTPRequestHandler):
    server_version = "XianqijiLibrary"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self.handle_api()

    def do_POST(self):
        self.handle_api()

    def handle_api(self):
        try:
            writer = self.server.library.authorize(self.headers.get("Authorization"), self.command != "GET")
            require(self.headers.get("Transfer-Encoding") is None, "Chunked requests unsupported")
            body = {}
            if self.command == "POST":
                try:
                    length = int(self.headers.get("Content-Length", "-1"))
                except ValueError:
                    raise ApiError(400, "Invalid content length")
                require(0 <= length <= MAX_JSON, "Request body too large", 413)
                data = self.rfile.read(length)
                require(len(data) == length, "Request body incomplete")
                try:
                    body = json.loads(data.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
                except (ValueError, UnicodeDecodeError):
                    raise ApiError(400, "Invalid JSON")
                require(isinstance(body, dict), "JSON object required")
            url = urlsplit(self.path)
            result = self.server.library.dispatch(self.command, url.path, parse_qs(url.query), body, writer)
            self.respond(200, result)
        except ApiError as error:
            self.respond(error.status, {"error": error.message})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            self.respond(500, {"error": "Server operation failed; committed library preserved"})

    def respond(self, status, value):
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *arguments):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*arguments)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    os.umask(0o077)
    library = Library(os.environ.get("XQ_LIBRARY_DATA", "/srv/xianqiji-library"), os.environ.get("XQ_LIBRARY_AUTH", "/etc/xianqiji-library/auth.json"))
    server = Server(("127.0.0.1", int(os.environ.get("XQ_LIBRARY_PORT", "8765"))), Handler)
    server.library = library
    server.serve_forever()
