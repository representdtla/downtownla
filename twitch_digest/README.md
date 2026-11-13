# Twitch 아침 브리핑 봇

매일 아침 10시(KST)에 지난 24시간을 요약해서 Slack으로 보내줍니다.

- 🎮 **게임 이슈** — 채널에 설정된 게임 카테고리(어제 방송 중 바꾼 카테고리 포함)의 패치·점검·커뮤니티 화제를 Claude가 웹 검색으로 찾아 출처 링크와 함께 정리
- 💬 **채팅 하이라이트** — 채팅이 몰린 순간, 반복된 질문/요청, 시청자 반응
- 🛡️ **모더레이션** — 밴/타임아웃/메시지 삭제, 채팅 모드 변경
- 🎬 **인기 클립**, 레이드/구독/비트
- ✅ **오늘 방송에서 챙길 포인트**

## 동작 방식

| 워크플로 | 주기 | 하는 일 |
|---|---|---|
| `twitch-chat-logger.yml` | 30분마다 | 방송 중이면 끝날 때까지 채팅을 익명(읽기 전용)으로 기록 → 아티팩트로 3일 보관 |
| `twitch-daily-digest.yml` | 매일 01:00 UTC (=10:00 KST) | Twitch API(카테고리·클립·VOD) + 채팅 로그 → Claude 요약 → Slack |

채팅 봇은 `justinfan` 익명 접속이라 봇 계정이 필요 없고 채팅에 아무것도 쓰지 않습니다.

## 설정 (한 번만)

1. **Twitch 앱** — https://dev.twitch.tv/console/apps 에서 앱 등록 (OAuth Redirect URL은 `http://localhost`, 카테고리 아무거나) → Client ID / Client Secret 발급
2. **Slack Incoming Webhook** — https://api.slack.com/apps → Create App → *Incoming Webhooks* 켜기 → 받을 채널 선택 → Webhook URL 복사
3. **Anthropic API 키** — https://console.anthropic.com
4. GitHub 저장소 → *Settings → Secrets and variables → Actions*

   **Secrets**
   - `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
   - `ANTHROPIC_API_KEY`
   - `SLACK_WEBHOOK_URL`

   **Variables**
   - `TWITCH_CHANNEL` — 내 채널 로그인 이름 (예: `mychannel`) — 필수
   - `GAME_NAMES` — (선택) 쉼표로 구분. 넣으면 채널 카테고리 대신 이 게임들을 조사
   - `TIMEZONE` — (선택) 기본 `Asia/Seoul`

5. *Actions* 탭 → **Twitch daily digest** → *Run workflow* 로 바로 테스트

## 참고 / 한계

- **채팅 기록은 설정한 이후부터** 쌓입니다. 첫날 브리핑에는 게임 이슈와 클립만 나옵니다.
- 30분 간격 확인이라 방송 시작 후 최대 30분(+ GitHub 스케줄 지연)은 채팅이 빠질 수 있습니다. 방송 켤 때 *Twitch chat logger → Run workflow*를 누르면 바로 시작합니다.
- GitHub Actions 사용량: **공개 저장소는 무료**. 비공개 저장소는 월 2,000분 무료인데, 30분 확인만으로 월 ~1,440분 + 방송 시간만큼 더 쓰므로 방송이 길면 초과합니다.
- 공개 저장소면 아티팩트(채팅 로그)를 GitHub 로그인 사용자가 내려받을 수 있습니다. 공개 채팅이긴 하지만 신경 쓰이면 비공개 저장소를 쓰세요.
- 매일 Claude API 호출 1회(웹 검색 최대 10회) 비용이 듭니다. 거절(refusal) 시 서버 측 fallback 모델로 자동 재시도하도록 켜져 있습니다.

## 로컬 실행

```bash
pip install -r twitch_digest/requirements.txt
export TWITCH_CHANNEL=... TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... ANTHROPIC_API_KEY=...
DRY_RUN=1 python -m twitch_digest.digest     # Slack 대신 화면에 출력
python -m twitch_digest.chat_logger          # 방송 중이면 ./chatlogs 에 기록
```
