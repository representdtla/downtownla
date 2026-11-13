"""Twitch Helix API 최소 클라이언트 (앱 액세스 토큰 사용)."""

from __future__ import annotations

from datetime import datetime, timezone

import requests

HELIX = "https://api.twitch.tv/helix"


def rfc3339(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Twitch:
    def __init__(self, client_id: str, client_secret: str):
        r = requests.post(
            "https://id.twitch.tv/oauth2/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "client_credentials",
            },
            timeout=30,
        )
        r.raise_for_status()
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Client-Id": client_id,
                "Authorization": f"Bearer {r.json()['access_token']}",
            }
        )

    def _get(self, path: str, **params) -> dict:
        r = self.session.get(f"{HELIX}/{path}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()

    def user(self, login: str) -> dict:
        data = self._get("users", login=login)["data"]
        if not data:
            raise SystemExit(f"Twitch 채널을 찾을 수 없습니다: {login}")
        return data[0]

    def channel(self, broadcaster_id: str) -> dict:
        """현재 채널 정보 (game_name = 지금 설정된 카테고리)."""
        return self._get("channels", broadcaster_id=broadcaster_id)["data"][0]

    def live_stream(self, user_id: str) -> dict | None:
        data = self._get("streams", user_id=user_id)["data"]
        return data[0] if data else None

    def clips(self, broadcaster_id: str, start: datetime, end: datetime, limit: int = 50) -> list[dict]:
        clips: list[dict] = []
        cursor = None
        while len(clips) < limit:
            params = {
                "broadcaster_id": broadcaster_id,
                "started_at": rfc3339(start),
                "ended_at": rfc3339(end),
                "first": 100,
            }
            if cursor:
                params["after"] = cursor
            page = self._get("clips", **params)
            clips.extend(page["data"])
            cursor = page.get("pagination", {}).get("cursor")
            if not cursor or not page["data"]:
                break
        clips.sort(key=lambda c: c.get("view_count", 0), reverse=True)
        return clips[:limit]

    def archives(self, user_id: str, since: datetime) -> list[dict]:
        """since 이후에 시작된 지난 방송(VOD) 목록."""
        vids = self._get("videos", user_id=user_id, type="archive", first=20)["data"]
        return [
            v
            for v in vids
            if datetime.fromisoformat(v["created_at"].replace("Z", "+00:00")) >= since
        ]
