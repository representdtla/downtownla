# 🚨 Korea Emergency Hotline

해외 오피스에서 **버튼 하나**를 누르면 **한국 담당자 전원에게 동시에 전화**가 걸리는 비상연락 프로그램입니다.

- 전화를 받으면 한국어 음성으로 호출 내용을 읽어 주고, **1번을 누르면 "확인"** 처리됩니다.
- 안 받거나 1번을 누르지 않으면 **자동으로 다시 겁니다** (기본: 최대 3번, 60초 간격).
- 버튼 페이지에서 누가 확인했는지 실시간으로 보이고, 상황이 끝나면 **호출 중지** 버튼으로 남은 재시도를 취소합니다.
- **한국 번호(+82)만** 호출합니다. 다른 국가 번호는 등록할 수 없습니다.
- 페이지는 PIN 으로 보호됩니다. PIN 을 5번 틀리면 10분 동안 잠깁니다.

## 1. 바로 테스트해 보기 (전화 안 걸림)

Twilio 를 설정하지 않으면 **테스트 모드**로 실행되어, 실제 발신 없이 화면만 확인할 수 있습니다. 테스트 PIN 은 `0000` 입니다.

```bash
cd hotline
npm install
cp contacts.example.json contacts.json
npm start
# → http://localhost:3000
```

## 2. 담당자 등록 — `contacts.json`

```json
[
  { "name": "홍길동", "role": "인프라 1순위", "phone": "010-1234-5678" },
  { "name": "김철수", "role": "백엔드",      "phone": "010-2345-6789" }
]
```

`010-1234-5678`, `+82 10 1234 5678` 형식 모두 받습니다. 파일을 고치면 서버를 다시 시작하지 않아도 다음 호출부터 반영됩니다.

## 3. 실제 전화 걸기 — Twilio 설정

1. [twilio.com](https://www.twilio.com) 에 가입하고 전화번호를 하나 구매합니다 (미국 번호여도 됩니다).
2. Console → **Voice → Settings → Geo permissions** 에서 **South Korea** 를 켭니다. *(꺼져 있으면 한국으로 발신이 안 됩니다)*
3. **Trial(무료) 계정**은 미리 인증한 번호(Verified Caller IDs)로만 걸 수 있으니, 운영 전에 유료로 전환하세요.
4. Account SID, Auth Token, 구매한 번호를 `.env` 에 넣습니다:

```bash
cp .env.example .env
# HOTLINE_PIN, PUBLIC_BASE_URL, TWILIO_* 값 입력
```

5. **https 주소가 있는 곳에 배포**합니다 (Render, Railway, Fly.io, AWS 등). Twilio 가 이 서버로 콜백을 보내야 하므로 `PUBLIC_BASE_URL` 은 외부에서 접속되는 https 주소여야 합니다.

> ⚠️ **감시할 서버와 다른 곳에 배포하세요.** 같은 서버에 두면 서버가 죽을 때 비상연락망도 같이 죽습니다.

## 4. 운영 팁

- **발신번호를 담당자 폰에 "비상 핫라인"으로 저장**해 두세요. 해외번호(+1)는 국내 통신사나 앱의 스팸 필터에 걸릴 수 있습니다.
- 처음 배포하면 **훈련 호출**을 한 번 해 보세요. 실제로 받고, 1번을 누르고, 화면이 "확인"으로 바뀌는지 확인합니다.
- 호출 기록은 `incidents.log` (JSON Lines) 에 남습니다. 화면의 진행 상황은 메모리에 있어서 서버를 재시작하면 사라집니다.
- 통화 요금은 [Twilio 한국 발신 요금](https://www.twilio.com/en-us/voice/pricing/kr) 을 참고하세요.

## 설정값

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOTLINE_PIN` | (필수) | 버튼 페이지 접속 PIN |
| `PUBLIC_BASE_URL` | (필수) | 이 서버의 공개 https 주소 |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | — | 세 값이 모두 없으면 테스트 모드 |
| `MAX_ATTEMPTS` | 3 | 1번을 누를 때까지 최대 발신 횟수 |
| `RETRY_DELAY_SECONDS` | 60 | 재시도 간격 |
| `RING_TIMEOUT_SECONDS` | 30 | 벨 울리는 시간 |
| `TTS_VOICE` | Polly.Seoyeon | 한국어 음성 |
| `CONTACTS_FILE` | ./contacts.json | 담당자 목록 파일 |
