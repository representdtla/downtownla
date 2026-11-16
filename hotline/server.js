'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
const cfg = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  pin: process.env.HOTLINE_PIN || '',
  sid: process.env.TWILIO_ACCOUNT_SID || '',
  token: process.env.TWILIO_AUTH_TOKEN || '',
  from: process.env.TWILIO_FROM_NUMBER || '',
  voice: process.env.TTS_VOICE || 'Polly.Seoyeon',
  maxAttempts: Math.max(1, Number(process.env.MAX_ATTEMPTS || 3)),
  retryDelaySec: Math.max(5, Number(process.env.RETRY_DELAY_SECONDS || 60)),
  ringTimeoutSec: Math.max(10, Number(process.env.RING_TIMEOUT_SECONDS || 30)),
  contactsFile: process.env.CONTACTS_FILE || path.join(__dirname, 'contacts.json'),
  logFile: process.env.LOG_FILE || path.join(__dirname, 'incidents.log'),
};

const DRY_RUN = !(cfg.sid && cfg.token && cfg.from);

if (!cfg.pin) {
  if (DRY_RUN) {
    cfg.pin = '0000';
    console.warn('[경고] HOTLINE_PIN 이 없어 테스트용 PIN "0000" 을 사용합니다.');
  } else {
    console.error('[오류] 실제 발신 모드에서는 HOTLINE_PIN 이 반드시 필요합니다.');
    process.exit(1);
  }
}
if (!DRY_RUN && !/^https:\/\//.test(cfg.baseUrl)) {
  console.error('[오류] PUBLIC_BASE_URL 은 Twilio 가 접근할 수 있는 https 주소여야 합니다.');
  process.exit(1);
}

const twilio = DRY_RUN ? null : require('twilio');
const client = DRY_RUN ? null : twilio(cfg.sid, cfg.token);

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

/** 한국 번호만 허용. "010-1234-5678", "+82 10 1234 5678" 등을 +821012345678 로 변환. */
function toKoreanE164(raw) {
  const s = String(raw || '').trim();
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) {
    if (!digits.startsWith('82')) throw new Error(`한국(+82) 번호가 아닙니다: ${raw}`);
  } else if (digits.startsWith('82')) {
    // 이미 국가코드 포함
  } else if (digits.startsWith('0')) {
    digits = '82' + digits.slice(1);
  } else {
    throw new Error(`번호 형식을 알 수 없습니다: ${raw}`);
  }
  if (!/^82\d{8,11}$/.test(digits)) throw new Error(`번호 길이가 올바르지 않습니다: ${raw}`);
  return '+' + digits;
}

/** 화면 표시용: +821012345678 -> 010-****-5678 */
function maskPhone(e164) {
  const local = '0' + e164.slice(3);
  return local.slice(0, 3) + '-****-' + local.slice(-4);
}

function loadContacts() {
  const raw = JSON.parse(fs.readFileSync(cfg.contactsFile, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('contacts.json 에 담당자가 없습니다.');
  return raw.map((c, i) => {
    if (!c.name || !c.phone) throw new Error(`contacts.json ${i + 1}번째 항목에 name/phone 이 없습니다.`);
    return { name: String(c.name), role: c.role ? String(c.role) : '', to: toKoreanE164(c.phone) };
  });
}

function xml(s) {
  return String(s).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
}

function logEvent(event, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  console.log(line);
  fs.appendFile(cfg.logFile, line + '\n', () => {});
}

function pinMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(cfg.pin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// 호출(incident) 상태 — 메모리에 보관, 이벤트는 incidents.log 에도 기록
// ---------------------------------------------------------------------------
const incidents = new Map(); // id -> incident
const TERMINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

function publicIncident(inc) {
  return {
    id: inc.id,
    createdAt: inc.createdAt,
    sender: inc.sender,
    message: inc.message,
    stopped: inc.stopped,
    calls: inc.calls.map((c) => ({
      name: c.name,
      role: c.role,
      phone: maskPhone(c.to),
      status: c.status,
      attempts: c.attempts,
      maxAttempts: cfg.maxAttempts,
      acknowledged: c.acknowledged,
      ackAt: c.ackAt,
      nextRetryAt: c.nextRetryAt,
    })),
  };
}

function setStatus(inc, c, status) {
  if (c.status === status) return;
  c.status = status;
  logEvent('call_status', { incident: inc.id, name: c.name, attempt: c.attempts, status });
}

function acknowledge(inc, c) {
  if (c.acknowledged) return;
  c.acknowledged = true;
  c.ackAt = new Date().toISOString();
  logEvent('acknowledged', { incident: inc.id, name: c.name, attempt: c.attempts });
}

/** 통화가 끝났는데 확인(1번)을 못 받았으면 재시도 예약 */
function handleCallEnded(inc, c) {
  if (c.acknowledged || inc.stopped) return;
  if (c.attempts >= cfg.maxAttempts) {
    setStatus(inc, c, 'gave-up');
    return;
  }
  const delay = (DRY_RUN ? Math.min(cfg.retryDelaySec, 5) : cfg.retryDelaySec) * 1000;
  c.nextRetryAt = new Date(Date.now() + delay).toISOString();
  setStatus(inc, c, 'retry-wait');
  c.timer = setTimeout(() => placeCall(inc, c), delay);
}

async function placeCall(inc, c) {
  if (inc.stopped || c.acknowledged) return;
  c.timer = null;
  c.nextRetryAt = null;
  c.attempts += 1;
  setStatus(inc, c, 'queued');

  if (DRY_RUN) return simulateCall(inc, c);

  try {
    const base = `${cfg.baseUrl}/twilio`;
    const call = await client.calls.create({
      to: c.to,
      from: cfg.from,
      url: `${base}/voice/${inc.id}/${c.idx}`,
      method: 'POST',
      statusCallback: `${base}/status/${inc.id}/${c.idx}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: cfg.ringTimeoutSec,
    });
    c.callSid = call.sid;
  } catch (err) {
    logEvent('call_error', { incident: inc.id, name: c.name, attempt: c.attempts, error: err.message });
    setStatus(inc, c, 'failed');
    handleCallEnded(inc, c);
  }
}

/** Twilio 자격증명이 없을 때: 화면 테스트용 가짜 통화 */
function simulateCall(inc, c) {
  const sid = 'SIM' + crypto.randomBytes(6).toString('hex');
  c.callSid = sid;
  const later = (ms, fn) => setTimeout(() => { if (c.callSid === sid && !inc.stopped) fn(); }, ms);
  later(800, () => setStatus(inc, c, 'ringing'));
  if (Math.random() < 0.6) {
    later(3500, () => setStatus(inc, c, 'in-progress'));
    later(6000, () => { acknowledge(inc, c); setStatus(inc, c, 'completed'); });
  } else {
    later(5000, () => { setStatus(inc, c, 'no-answer'); handleCallEnded(inc, c); });
  }
}

function voiceScript(inc) {
  const who = inc.sender ? `${inc.sender}님이 호출했습니다. ` : '';
  return `긴급 비상 호출입니다. 해외 오피스에서 ${who}내용은 다음과 같습니다. ${inc.message}. 확인하셨으면 1번을 눌러주세요.`;
}

// ---------------------------------------------------------------------------
// 앱
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, dryRun: DRY_RUN }));

// --- PIN 보호 (5회 틀리면 10분 잠금) ---------------------------------------
const failures = new Map(); // ip -> { count, until }
function requirePin(req, res, next) {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    return res.status(429).json({ error: 'PIN 을 여러 번 틀려 10분간 잠겼습니다.' });
  }
  if (!pinMatches(req.get('x-hotline-pin'))) {
    const count = (f && !f.until ? f.count : 0) + 1; // 잠금이 풀린 뒤에는 0부터 다시
    failures.set(ip, { count, until: count >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'PIN 이 올바르지 않습니다.' });
  }
  failures.delete(ip);
  next();
}

app.get('/api/config', requirePin, (_req, res) => {
  try {
    const contacts = loadContacts().map((c) => ({ name: c.name, role: c.role, phone: maskPhone(c.to) }));
    res.json({ dryRun: DRY_RUN, maxAttempts: cfg.maxAttempts, contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alert', requirePin, (req, res) => {
  let contacts;
  try {
    contacts = loadContacts();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const message = String(req.body.message || '').trim().slice(0, 300) || '서버 장애가 발생했습니다. 즉시 확인 바랍니다.';
  const sender = String(req.body.sender || '').trim().slice(0, 40);

  const inc = {
    id: crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    message,
    sender,
    stopped: false,
    calls: contacts.map((c, idx) => ({
      ...c, idx, status: 'pending', attempts: 0, acknowledged: false, ackAt: null,
      callSid: null, timer: null, nextRetryAt: null,
    })),
  };
  incidents.set(inc.id, inc);
  logEvent('alert', { incident: inc.id, sender, message, contacts: contacts.map((c) => c.name), ip: req.ip });

  // 모든 담당자에게 동시에 발신
  inc.calls.forEach((c) => placeCall(inc, c));
  res.status(201).json(publicIncident(inc));
});

app.get('/api/incidents', requirePin, (_req, res) => {
  const list = [...incidents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  res.json(list.map(publicIncident));
});

app.get('/api/incidents/:id', requirePin, (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) return res.status(404).json({ error: '호출을 찾을 수 없습니다.' });
  res.json(publicIncident(inc));
});

/** 호출 중지: 재시도 취소 + 진행 중인 통화 종료 */
app.post('/api/incidents/:id/stop', requirePin, async (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) return res.status(404).json({ error: '호출을 찾을 수 없습니다.' });
  inc.stopped = true;
  logEvent('stopped', { incident: inc.id, ip: req.ip });
  await Promise.all(inc.calls.map(async (c) => {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.nextRetryAt = null;
    if (c.acknowledged || TERMINAL.has(c.status) || c.status === 'gave-up') {
      if (c.status === 'retry-wait') setStatus(inc, c, 'canceled');
      return;
    }
    if (c.status === 'retry-wait' || c.status === 'pending') return setStatus(inc, c, 'canceled');
    if (!DRY_RUN && c.callSid) {
      try { await client.calls(c.callSid).update({ status: 'completed' }); } catch { /* 이미 종료된 통화 */ }
    }
    setStatus(inc, c, 'canceled');
  }));
  res.json(publicIncident(inc));
});

// --- Twilio 웹훅 -----------------------------------------------------------
function verifyTwilio(req, res, next) {
  if (DRY_RUN) return next();
  const ok = twilio.validateRequest(cfg.token, req.get('x-twilio-signature') || '', cfg.baseUrl + req.originalUrl, req.body);
  if (!ok) return res.status(403).send('invalid signature');
  next();
}

function findCall(req) {
  const inc = incidents.get(req.params.id);
  const c = inc && inc.calls[Number(req.params.idx)];
  return c ? { inc, c } : null;
}

function twiml(res, body) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function say(text) {
  return `<Say voice="${xml(cfg.voice)}" language="ko-KR">${xml(text)}</Say>`;
}

// 전화를 받았을 때 읽어줄 음성 + 1번 입력 대기 (3회 반복)
app.post('/twilio/voice/:id/:idx', verifyTwilio, (req, res) => {
  const found = findCall(req);
  if (!found) return twiml(res, say('유효하지 않은 호출입니다.') + '<Hangup/>');
  const { inc, c } = found;
  const action = `${cfg.baseUrl}/twilio/ack/${inc.id}/${c.idx}`;
  const gather = `<Gather input="dtmf" numDigits="1" timeout="6" action="${xml(action)}" method="POST">${say(voiceScript(inc))}</Gather>`;
  twiml(res, gather.repeat(3) + say('입력이 없어 통화를 종료합니다. 잠시 후 다시 전화드리겠습니다.') + '<Hangup/>');
});

// 키패드 입력 처리
app.post('/twilio/ack/:id/:idx', verifyTwilio, (req, res) => {
  const found = findCall(req);
  if (!found) return twiml(res, '<Hangup/>');
  const { inc, c } = found;
  if (req.body.Digits === '1') {
    acknowledge(inc, c);
    return twiml(res, say('확인되었습니다. 감사합니다.') + '<Hangup/>');
  }
  twiml(res, `<Redirect method="POST">${xml(`${cfg.baseUrl}/twilio/voice/${inc.id}/${c.idx}`)}</Redirect>`);
});

// 통화 상태 콜백
app.post('/twilio/status/:id/:idx', verifyTwilio, (req, res) => {
  res.sendStatus(204);
  const found = findCall(req);
  if (!found) return;
  const { inc, c } = found;
  if (req.body.CallSid !== c.callSid) return; // 이전 시도의 늦은 콜백 무시
  const status = req.body.CallStatus;
  if (c.status === 'canceled') return;
  setStatus(inc, c, status);
  if (TERMINAL.has(status)) handleCallEnded(inc, c);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(cfg.port, () => {
  console.log(`핫라인 서버 실행: http://localhost:${cfg.port}  (${DRY_RUN ? '테스트 모드 — 실제 전화 안 걸림' : '실제 발신 모드'})`);
});
