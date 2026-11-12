import copy
import json
import math
import os
import secrets
import socket
import sqlite3
import threading
import time

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


BASE_DIR = Path(__file__).resolve().parent

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))

DB_PATH = Path(
    os.environ.get(
        "ROOMS_DB",
        str(BASE_DIR / "rooms.sqlite3"),
    )
).expanduser()

MAX_STUDENTS = 40
DEFAULT_STUDENTS = 20

MIN_LAPS = 1
MAX_LAPS = 10
DEFAULT_LAPS = 5

DEFAULT_PACE = 60.0
MAX_PACE = 5999.99

rooms = {}
rooms_lock = threading.RLock()


# ============================================================
# データベース
# ============================================================

def open_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(
        str(DB_PATH),
        timeout=10,
    )

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS rooms (
            room_key TEXT PRIMARY KEY,
            data TEXT NOT NULL
        )
        """
    )

    return connection


def serialize_room(room):
    saved = copy.deepcopy(room)

    # 単調時計とBの接続状態は再起動後には使えない。
    saved["started_at"] = None
    saved["last_b_seen"] = 0.0

    return json.dumps(
        saved,
        ensure_ascii=False,
        allow_nan=False,
    )


def save_room(room):
    """rooms_lock の取得中に呼び出す。"""

    connection = open_database()

    try:
        with connection:
            connection.execute(
                """
                INSERT INTO rooms (room_key, data)
                VALUES (?, ?)
                ON CONFLICT(room_key)
                DO UPDATE SET data = excluded.data
                """,
                (
                    room["key"],
                    serialize_room(room),
                ),
            )
    finally:
        connection.close()


# ============================================================
# 部屋・ランナー
# ============================================================

def new_student(index):
    return {
        "id": index,
        "name": f"生徒{index + 1:02d}",
        "target": DEFAULT_LAPS,
        "target_pace": DEFAULT_PACE,
        "remaining": DEFAULT_LAPS,
        # 各周を通過した時点の、スタートからの累計秒数。
        "laps": [],
        "finish_time": None,
        "completed_laps": None,
        "retired": False,
        "revision": 0,
    }


def new_room():
    while True:
        key = secrets.token_hex(6).upper()

        if key not in rooms:
            break

    return {
        "key": key,
        "admin_token": secrets.token_urlsafe(24),
        "version": 0,
        "run_id": secrets.token_hex(8),
        "screen": "setup",
        "running": False,
        "started_at": None,
        "started_at_wall": None,
        "elapsed": 0.0,
        "draft_count": DEFAULT_STUDENTS,
        "student_count": DEFAULT_STUDENTS,
        "students": [
            new_student(i)
            for i in range(DEFAULT_STUDENTS)
        ],
        "last_b_seen": 0.0,
        "finish_requests": {},
    }


def normalize_target(value):
    if type(value) is not int:
        return DEFAULT_LAPS

    return max(MIN_LAPS, min(MAX_LAPS, value))


def normalize_pace(value):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
        or value > MAX_PACE
    ):
        return DEFAULT_PACE

    return round(float(value), 2)


def reset_student_measurement(student):
    """名前・周数・目標ペースを残して記録を初期化する。"""

    student["target"] = normalize_target(
        student.get("target")
    )

    student["target_pace"] = normalize_pace(
        student.get("target_pace")
    )

    student["remaining"] = student["target"]
    student["laps"] = []
    student["finish_time"] = None
    student["completed_laps"] = None
    student["retired"] = False
    student["revision"] = student.get("revision", 0) + 1


def reset_measurement(room):
    """設定を残して、全員の計測結果を初期化する。"""

    room["running"] = False
    room["started_at"] = None
    room["started_at_wall"] = None
    room["elapsed"] = 0.0
    room["run_id"] = secrets.token_hex(8)
    room["finish_requests"] = {}

    # 人数を減らして非表示になっている生徒も初期化する。
    for student in room["students"]:
        reset_student_measurement(student)

    room["version"] = room.get("version", 0) + 1


def load_rooms():
    """
    保存済みの部屋を読み込む。

    従来の動作に合わせ、サーバー再起動時は計測結果を初期化。
    名前・目標周数・目標ペースは維持する。
    """

    connection = open_database()
    restored = {}

    try:
        rows = connection.execute(
            "SELECT room_key, data FROM rooms"
        ).fetchall()

        for key, raw_data in rows:
            room = json.loads(raw_data)

            if room.get("key") != key:
                raise ValueError(
                    f"部屋データのキーが一致しません: {key}"
                )

            if not isinstance(room.get("students"), list):
                raise ValueError(
                    f"生徒データが不正です: {key}"
                )

            room["last_b_seen"] = 0.0

            # 旧データに target_pace などを追加し、
            # 計測結果を初期化する。
            reset_measurement(room)

            restored[key] = room

        with connection:
            for room in restored.values():
                connection.execute(
                    """
                    UPDATE rooms
                    SET data = ?
                    WHERE room_key = ?
                    """,
                    (
                        serialize_room(room),
                        room["key"],
                    ),
                )
    finally:
        connection.close()

    with rooms_lock:
        rooms.clear()
        rooms.update(restored)


def elapsed_of(room, now=None):
    if now is None:
        now = time.monotonic()

    if room["running"] and room["started_at"] is not None:
        return max(
            0.0,
            now - room["started_at"],
        )

    return float(room.get("elapsed", 0.0))


def room_snapshot(room):
    now = time.monotonic()

    return {
        "key": room["key"],
        "version": room["version"],
        "run_id": room["run_id"],
        "screen": room["screen"],
        "running": room["running"],
        "elapsed": elapsed_of(room, now),
        "draft_count": room["draft_count"],
        "student_count": room["student_count"],
        "students": [
            copy.deepcopy(student)
            for student in room["students"][
                :room["student_count"]
            ]
        ],
        "b_connected": (
            room.get("last_b_seen", 0) > 0
            and now - room["last_b_seen"] < 3.0
        ),
    }


# ============================================================
# 入力・権限チェック
# ============================================================

def checked_integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{label}は{minimum}〜{maximum}の整数で入力してください。"
        )

    return value


def checked_pace(value):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
        or value > MAX_PACE
    ):
        raise ValueError(
            "目標ペースは0秒より大きく、99:59.99以下にしてください。"
        )

    rounded = round(float(value), 2)

    if rounded <= 0:
        raise ValueError(
            "目標ペースは0.01秒以上にしてください。"
        )

    return rounded


def get_student(room, student_id):
    index = checked_integer(
        student_id,
        0,
        room["student_count"] - 1,
        "生徒番号",
    )

    return room["students"][index]


def require_admin(room, token):
    if (
        not isinstance(token, str)
        or not secrets.compare_digest(
            room["admin_token"],
            token,
        )
    ):
        raise PermissionError(
            "Aの認証情報が正しくありません。"
        )


def require_role(role, expected):
    if role != expected:
        raise PermissionError(
            f"{expected}専用の操作です。"
        )


def require_counter(room):
    if room["screen"] != "counter":
        raise ValueError(
            "記録画面で操作してください。"
        )


def require_running(room):
    require_counter(room)

    if not room["running"]:
        raise ValueError(
            "計測開始後に操作してください。"
        )


def require_current_run(room, payload):
    if payload.get("run_id") != room["run_id"]:
        raise ValueError(
            "走行が切り替わりました。"
            "最新画面を確認してください。"
        )


def require_not_retired(student):
    if student.get("retired", False):
        raise ValueError(
            "リタイヤ中は周回を変更できません。"
        )


def require_revision(student, payload):
    revision = payload.get("revision")

    if (
        type(revision) is not int
        or revision != student["revision"]
    ):
        raise ValueError(
            "記録が更新されています。"
            "最新画面を確認してください。"
        )


# ============================================================
# API操作
# ============================================================

def apply_operation(path, room, role, payload, received_at):
    if path == "/api/prepare":
        require_role(role, "A")

        if room["screen"] != "setup":
            raise ValueError(
                "人数選択画面で操作してください。"
            )

        count = checked_integer(
            payload.get("count"),
            1,
            MAX_STUDENTS,
            "人数",
        )

        while len(room["students"]) < count:
            room["students"].append(
                new_student(len(room["students"]))
            )

        room["student_count"] = count
        room["draft_count"] = count
        room["screen"] = "counter"

        reset_measurement(room)

    elif path == "/api/start":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        if room["running"]:
            raise ValueError("すでに計測中です。")

        room["started_at"] = time.monotonic()
        room["started_at_wall"] = time.time()
        room["elapsed"] = 0.0
        room["running"] = True
        room["version"] += 1

    elif path == "/api/setup":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        room["elapsed"] = elapsed_of(room)
        room["running"] = False
        room["started_at"] = None
        room["started_at_wall"] = None
        room["screen"] = "setup"
        room["draft_count"] = room["student_count"]
        room["run_id"] = secrets.token_hex(8)
        room["finish_requests"] = {}
        room["version"] += 1

    elif path == "/api/reset":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        reset_measurement(room)

    elif path == "/api/edit":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        student = get_student(
            room,
            payload.get("student_id"),
        )

        require_revision(student, payload)

        name = payload.get("name")

        if not isinstance(name, str):
            raise ValueError("名前を入力してください。")

        name = name.strip()

        if not 1 <= len(name) <= 100:
            raise ValueError(
                "名前は1〜100文字で入力してください。"
            )

        target = checked_integer(
            payload.get("target"),
            MIN_LAPS,
            MAX_LAPS,
            "目標周数",
        )

        target_pace = checked_pace(
            payload.get("target_pace")
        )

        target_changed = target != student["target"]
        reset = payload.get("reset") is True

        student["name"] = name
        student["target"] = target
        student["target_pace"] = target_pace

        if target_changed or reset:
            reset_student_measurement(student)
        else:
            student["revision"] += 1

        room["version"] += 1

    elif path == "/api/retire":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        student = get_student(
            room,
            payload.get("student_id"),
        )

        require_revision(student, payload)

        if student["finish_time"] is not None:
            raise ValueError(
                "完走済みのランナーは"
                "リタイヤにできません。"
            )

        retired = payload.get("retired")

        if type(retired) is not bool:
            raise ValueError(
                "リタイヤ状態が不正です。"
            )

        student["retired"] = retired
        student["revision"] += 1
        room["version"] += 1

    elif path == "/api/change":
        require_role(role, "A")
        require_running(room)
        require_current_run(room, payload)

        student = get_student(
            room,
            payload.get("student_id"),
        )

        require_revision(student, payload)
        require_not_retired(student)

        if student["finish_time"] is not None:
            raise ValueError(
                "完走済みの記録は変更できません。"
            )

        delta = payload.get("delta")

        if type(delta) is not int or delta not in (-1, 1):
            raise ValueError("操作が不正です。")

        if delta == -1:
            if student["remaining"] <= 1:
                raise ValueError(
                    "最後の−1はB専用です。"
                )

            # スタートからこの周までの累計時間を保存する。
            cumulative_time = max(
                0.0,
                received_at - room["started_at"],
            )

            if (
                student["laps"]
                and cumulative_time < student["laps"][-1]
            ):
                raise ValueError(
                    "記録の順序が不正です。"
                    "最新画面を確認してください。"
                )

            student["laps"].append(cumulative_time)
            student["remaining"] -= 1

        else:
            # 最後の周回記録を取り消す。
            if not student["laps"]:
                raise ValueError(
                    "取り消せる周回記録がありません。"
                )

            student["laps"].pop()
            student["remaining"] += 1

        student["revision"] += 1
        room["version"] += 1

    elif path == "/api/finish":
        require_role(role, "B")
        require_running(room)
        require_current_run(room, payload)

        request_id = payload.get("request_id")

        if (
            not isinstance(request_id, str)
            or not 1 <= len(request_id) <= 100
        ):
            raise ValueError("操作番号が不正です。")

        # 同じリクエストの再送による二重記録を防ぐ。
        if request_id in room["finish_requests"]:
            return

        student = get_student(
            room,
            payload.get("student_id"),
        )

        require_revision(student, payload)
        require_not_retired(student)

        if (
            student["remaining"] != 1
            or student["finish_time"] is not None
        ):
            raise ValueError(
                "残り1周のランナーだけ"
                "ゴールを記録できます。"
            )

        if received_at < room["started_at"]:
            raise ValueError(
                "スタート前の操作は記録できません。"
            )

        finish_time = received_at - room["started_at"]

        if (
            student["laps"]
            and finish_time < student["laps"][-1]
        ):
            raise ValueError(
                "記録の順序が不正です。"
                "最新画面を確認してください。"
            )

        student["laps"].append(finish_time)
        student["remaining"] = 0
        student["finish_time"] = finish_time
        student["completed_laps"] = student["target"]
        student["revision"] += 1
        room["version"] += 1

        room["finish_requests"][request_id] = True

        if len(room["finish_requests"]) > 2000:
            oldest = next(iter(room["finish_requests"]))
            del room["finish_requests"][oldest]

    else:
        raise ValueError("不明な操作です。")


# ============================================================
# HTTPサーバー
# ============================================================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format_string, *args):
        print(
            f"{self.address_string()} - "
            f"{format_string % args}"
        )

    def send_json(self, status, payload):
        body = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")

        try:
            self.send_response(status)

            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )

            self.send_header(
                "Cache-Control",
                "no-store",
            )

            self.send_header(
                "Content-Length",
                str(len(body)),
            )

            self.end_headers()
            self.wfile.write(body)

        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file(self, filename, content_type):
        try:
            body = (
                BASE_DIR / filename
            ).read_bytes()
        except OSError:
            self.send_error(404)
            return

        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json(self):
        try:
            length = int(
                self.headers.get(
                    "Content-Length",
                    "0",
                )
            )

            if not 1 <= length <= 8192:
                raise ValueError(
                    "送信データのサイズが不正です。"
                )

            payload = json.loads(
                self.rfile.read(length).decode("utf-8")
            )

            if not isinstance(payload, dict):
                raise ValueError(
                    "送信データの形式が不正です。"
                )

            return payload

        except (
            ValueError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise ValueError(
                "送信データを読み取れません。"
            ) from error

    def get_room_and_role(self):
        key = self.headers.get(
            "X-Room-Key",
            "",
        ).strip().upper()

        role = self.headers.get(
            "X-Role",
            "",
        ).strip().upper()

        if role not in ("A", "B", "C"):
            raise PermissionError(
                "役割が正しくありません。"
            )

        room = rooms.get(key)

        if room is None:
            raise ValueError(
                "接続キーに対応する部屋がありません。"
            )

        if role == "A":
            require_admin(
                room,
                self.headers.get("X-Admin-Token", ""),
            )

        return room, role

    def do_GET(self):
        path = urlsplit(self.path).path

        if path in ("/", "/index.html"):
            self.send_file(
                "index.html",
                "text/html; charset=utf-8",
            )
            return

        if path == "/style.css":
            self.send_file(
                "style.css",
                "text/css; charset=utf-8",
            )
            return

        if path == "/app.js":
            self.send_file(
                "app.js",
                "application/javascript; charset=utf-8",
            )
            return

        if path != "/api/state":
            self.send_error(404)
            return

        try:
            with rooms_lock:
                room, role = self.get_room_and_role()

                if role == "B":
                    room["last_b_seen"] = time.monotonic()

                snapshot = room_snapshot(room)

            self.send_json(
                200,
                {
                    "ok": True,
                    "state": snapshot,
                },
            )

        except PermissionError as error:
            self.send_json(
                403,
                {
                    "ok": False,
                    "error": str(error),
                },
            )

        except ValueError as error:
            self.send_json(
                400,
                {
                    "ok": False,
                    "error": str(error),
                },
            )

        except Exception as error:
            print(f"GET error: {error}")

            self.send_json(
                500,
                {
                    "ok": False,
                    "error": "サーバー内部でエラーが発生しました。",
                },
            )

    def do_POST(self):
        path = urlsplit(self.path).path

        try:
            payload = self.read_json()

            if path == "/api/create":
                with rooms_lock:
                    room = new_room()

                    # 保存に成功してからメモリへ登録する。
                    save_room(room)
                    rooms[room["key"]] = room

                    response = {
                        "ok": True,
                        "key": room["key"],
                        "admin_token": room["admin_token"],
                        "state": room_snapshot(room),
                    }

                self.send_json(200, response)
                return

            with rooms_lock:
                room, role = self.get_room_and_role()

                if role == "B":
                    room["last_b_seen"] = time.monotonic()

                # 更新と保存を失敗時に元へ戻せるようにする。
                before = copy.deepcopy(room)

                try:
                    received_at = time.monotonic()

                    apply_operation(
                        path,
                        room,
                        role,
                        payload,
                        received_at,
                    )

                    save_room(room)

                except Exception:
                    room.clear()
                    room.update(before)
                    raise

                snapshot = room_snapshot(room)

            self.send_json(
                200,
                {
                    "ok": True,
                    "state": snapshot,
                },
            )

        except PermissionError as error:
            self.send_json(
                403,
                {
                    "ok": False,
                    "error": str(error),
                },
            )

        except ValueError as error:
            self.send_json(
                400,
                {
                    "ok": False,
                    "error": str(error),
                },
            )

        except Exception as error:
            print(f"POST error: {error}")

            self.send_json(
                500,
                {
                    "ok": False,
                    "error": "サーバー内部でエラーが発生しました。",
                },
            )


def local_ip_address():
    try:
        with socket.socket(
            socket.AF_INET,
            socket.SOCK_DGRAM,
        ) as sock:
            sock.connect(("192.0.2.1", 1))
            return sock.getsockname()[0]
    except OSError:
        return "確認できません"


def main():
    load_rooms()

    server = ThreadingHTTPServer(
        (HOST, PORT),
        Handler,
    )

    print()
    print("持久走・周回カウンター")
    print(f"この端末: http://localhost:{PORT}")
    print(f"同じネットワーク: http://{local_ip_address()}:{PORT}")
    print(f"データベース: {DB_PATH}")
    print("終了するには Ctrl+C を押してください。")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを終了します。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
