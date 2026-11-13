"""방송 중일 때 Twitch 채팅을 읽기 전용(익명)으로 기록합니다.

GitHub Actions에서 주기적으로 실행됩니다:
  - 방송 중이 아니면 바로 종료
  - 방송 중이면 방송이 끝나거나 MAX_RUNTIME_MIN에 도달할 때까지 채팅을 JSONL로 저장

익명 로그인(justinfan)이라 봇 계정/토큰이 필요 없고, 채팅에 아무것도 쓰지 않습니다.
"""

from __future__ import annotations

import json
import os
import random
import socket
import ssl
import time
from datetime import datetime, timezone
from pathlib import Path

from .twitch import Twitch

IRC_HOST = "irc.chat.twitch.tv"
IRC_PORT = 6697
LIVE_CHECK_SEC = 300
OFFLINE_CHECKS_TO_STOP = 2


def _unescape(v: str) -> str:
    return (
        v.replace(r"\s", " ").replace(r"\:", ";").replace(r"\r", "\r").replace(r"\n", "\n").replace("\\\\", "\\")
    )


def parse_irc(line: str) -> tuple[dict, str | None, str, list[str], str | None]:
    tags: dict[str, str] = {}
    if line.startswith("@"):
        raw, line = line[1:].split(" ", 1)
        for kv in raw.split(";"):
            k, _, v = kv.partition("=")
            tags[k] = _unescape(v)
    prefix = None
    if line.startswith(":"):
        prefix, line = line[1:].split(" ", 1)
    trailing = None
    if " :" in line:
        line, trailing = line.split(" :", 1)
    parts = line.split()
    return tags, prefix, parts[0] if parts else "", parts[1:], trailing


def _ts(tags: dict) -> str:
    ms = tags.get("tmi-sent-ts")
    dt = datetime.fromtimestamp(int(ms) / 1000, timezone.utc) if ms else datetime.now(timezone.utc)
    return dt.isoformat()


def to_event(line: str) -> dict | None:
    tags, prefix, cmd, _params, trailing = parse_irc(line)
    if cmd == "PRIVMSG":
        badges = tags.get("badges", "")
        return {
            "type": "msg",
            "ts": _ts(tags),
            "id": tags.get("id"),
            "user": tags.get("display-name") or (prefix or "").split("!")[0],
            "text": trailing or "",
            "bits": int(tags["bits"]) if tags.get("bits") else 0,
            "mod": "moderator/" in badges or "broadcaster/" in badges,
            "sub": "subscriber/" in badges,
        }
    if cmd == "CLEARCHAT":
        if trailing:
            dur = tags.get("ban-duration")
            return {
                "type": "timeout" if dur else "ban",
                "ts": _ts(tags),
                "user": trailing,
                "duration": int(dur) if dur else None,
            }
        return {"type": "chat_cleared", "ts": _ts(tags)}
    if cmd == "CLEARMSG":
        return {"type": "deleted", "ts": _ts(tags), "user": tags.get("login"), "text": trailing or ""}
    if cmd == "USERNOTICE":
        return {
            "type": "notice",
            "ts": _ts(tags),
            "kind": tags.get("msg-id"),
            "system": tags.get("system-msg", ""),
            "text": trailing or "",
        }
    if cmd == "ROOMSTATE" and any(k in tags for k in ("emote-only", "slow", "followers-only", "subs-only")) and len(tags) <= 3:
        # 전체 상태 덤프(접속 시)가 아닌 변경분만 기록
        return {"type": "roomstate", "ts": datetime.now(timezone.utc).isoformat(), "tags": tags}
    return None


class Irc:
    def __init__(self, channel: str):
        self.channel = channel
        self.sock: ssl.SSLSocket | None = None
        self.buf = b""

    def connect(self) -> None:
        raw = socket.create_connection((IRC_HOST, IRC_PORT), timeout=30)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=IRC_HOST)
        self.sock.settimeout(30)
        self.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
        self.send("PASS SCHMOOPIIE")
        self.send(f"NICK justinfan{random.randint(10000, 99999)}")
        self.send(f"JOIN #{self.channel}")
        self.buf = b""

    def send(self, line: str) -> None:
        assert self.sock
        self.sock.sendall((line + "\r\n").encode())

    def close(self) -> None:
        try:
            if self.sock:
                self.sock.close()
        finally:
            self.sock = None

    def lines(self):
        """수신한 줄들을 yield. 타임아웃이면 아무것도 yield 하지 않고 반환."""
        assert self.sock
        try:
            chunk = self.sock.recv(65536)
        except socket.timeout:
            return
        if not chunk:
            raise ConnectionError("IRC 연결이 끊어졌습니다")
        self.buf += chunk
        *complete, self.buf = self.buf.split(b"\r\n")
        for raw in complete:
            yield raw.decode("utf-8", errors="replace")


def main() -> None:
    channel = os.environ["TWITCH_CHANNEL"].strip().lower()
    max_runtime = int(os.environ.get("MAX_RUNTIME_MIN", "340")) * 60
    out_dir = Path(os.environ.get("CHAT_LOG_DIR", "chatlogs"))

    tw = Twitch(os.environ["TWITCH_CLIENT_ID"], os.environ["TWITCH_CLIENT_SECRET"])
    user = tw.user(channel)
    stream = tw.live_stream(user["id"])
    if not stream:
        print(f"{channel}: 방송 중이 아님 → 종료")
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{channel}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.jsonl"
    print(f"{channel}: 방송 중 ({stream['game_name']}) → {path} 에 기록 시작")

    started = time.monotonic()
    next_check = 0.0
    offline_count = 0
    irc = Irc(channel)
    backoff = 1
    count = 0

    with path.open("a", encoding="utf-8") as f:

        def write(ev: dict) -> None:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
            f.flush()

        while time.monotonic() - started < max_runtime:
            now = time.monotonic()
            if now >= next_check:
                next_check = now + LIVE_CHECK_SEC
                try:
                    s = tw.live_stream(user["id"])
                except Exception as e:  # API 일시 오류는 무시하고 계속 기록
                    print(f"live check 실패: {e}")
                    s = stream
                if s:
                    offline_count = 0
                    write(
                        {
                            "type": "stream",
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "game": s.get("game_name"),
                            "title": s.get("title"),
                            "viewers": s.get("viewer_count"),
                        }
                    )
                else:
                    offline_count += 1
                    if offline_count >= OFFLINE_CHECKS_TO_STOP:
                        print("방송 종료 감지 → 기록 종료")
                        break

            try:
                if irc.sock is None:
                    irc.connect()
                for line in irc.lines():
                    if line.startswith("PING"):
                        irc.send("PONG" + line[4:])
                        continue
                    if " RECONNECT" in line[:80]:
                        raise ConnectionError("서버가 재접속 요청")
                    ev = to_event(line)
                    if ev:
                        write(ev)
                        count += 1
                backoff = 1
            except (OSError, ConnectionError, ssl.SSLError) as e:
                print(f"IRC 오류: {e} → {backoff}초 후 재접속")
                irc.close()
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)

    irc.close()
    print(f"기록 완료: 이벤트 {count}개")


if __name__ == "__main__":
    main()
