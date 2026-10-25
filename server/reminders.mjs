/**
 * 每日定时抓取 + 定时提醒。
 *
 * 为什么不用 cron 库：只需要「每天某个整点做一件事」和「每天几个时刻发一条通知」，
 * 一个每分钟的 tick 加日期戳就够 —— 而且进程重启后靠 settings 里的日期戳续上，
 * 不会漏也不会重发。
 *
 * 判定「该不该提醒」：
 *   有词到期  →  提醒
 *   今天什么都没做（没读完、没标记、没复习）→  也提醒
 * 也就是说：没事可做且今天已经学过，就不打扰。
 */

import { db, getSetting, setSetting } from './db.mjs';
import { startFetchJob, runningJob } from './jobs.mjs';
import { ensureVapid, sendToAll } from './push.mjs';

const TICK_MS = 60_000;

/** 本地时间的 YYYY-MM-DD。 */
function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 本地时间的 HH:MM。 */
function hhmm(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** 今天有没有学习行为。标记、复习、读完都算。 */
function studiedToday(day) {
  const n = db
    .prepare(
      `SELECT COUNT(*) AS c FROM activity
       WHERE at >= ? AND kind IN ('mark', 'review', 'read_done')`,
    )
    .get(`${day}T00:00:00`);
  return n.c > 0;
}

/** 到期的词数。和设置页那个数字同口径。 */
function dueCount(now = new Date()) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM vocab
       WHERE status != 'archived' AND (due_at IS NULL OR due_at <= ?)`,
    )
    .get(now.toISOString()).c;
}

// ---------------------------------------------------------------- 订阅存取

export function saveSubscription(sub, ua) {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('订阅缺少 endpoint / keys');
  }
  db.prepare(
    `INSERT INTO push_subs (endpoint, p256dh, auth, ua, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`,
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua ?? null, new Date().toISOString());
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
}

export function listSubscriptions() {
  return db.prepare('SELECT * FROM push_subs').all();
}

/** 给所有订阅发一条，失效的顺手删掉。 */
export async function pushAll(payload, vapid) {
  const subject = getSetting('pushSubject', 'mailto:noreply@localhost');
  const subs = listSubscriptions();
  if (subs.length === 0) return { sent: 0, results: [] };
  const results = await sendToAll(subs, payload, vapid, subject, removeSubscription);
  return { sent: results.filter((r) => r.ok).length, results };
}

// ---------------------------------------------------------------- 定时

/** 定时抓取的时刻（"HH:MM"）；空字符串表示关闭。兼容旧的 fetchHour。 */
function fetchAt() {
  const t = String(getSetting('fetchTime', ''));
  if (t) return t;
  const h = String(getSetting('fetchHour', ''));
  return h === '' ? '' : `${String(Number(h)).padStart(2, '0')}:00`;
}

/**
 * 每秒检查一次的那件事：到点了吗、做过了吗。
 *
 * 所有「做过了」的标记都写在 settings 里（lastFetchDay / lastRemindKey），
 * 所以重启不会重复执行，跨天也能自然续上。
 */
async function tick(now = new Date()) {
  // ---- 每天定时抓取（过了点也算：当天错过一次就补上，不必等到明天）
  const at = fetchAt();
  if (at) {
    const day = today(now);
    if (hhmm(now) >= at && getSetting('lastFetchDay', '') !== day) {
      if (!runningJob('fetch')) {
        setSetting('lastFetchDay', day); // 先记，避免抓取失败时每分钟重试
        try {
          startFetchJob({ want: Number(getSetting('fetchWant', '12')) || 12 });
        } catch {
          /* 抓取失败不该影响提醒 */
        }
      }
    }
  }

  // ---- 定时提醒
  if (getSetting('remindEnabled', '0') !== '1') return { reminded: false };
  const times = String(getSetting('remindTimes', ''))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  if (times.length === 0) return { reminded: false };

  const nowHm = hhmm(now);
  if (!times.includes(nowHm)) return { reminded: false };

  // 同一个「日期+时刻」只发一次
  const key = `${today(now)} ${nowHm}`;
  if (getSetting('lastRemindKey', '') === key) return { reminded: false };

  const due = dueCount(now);
  const studied = studiedToday(today(now));
  if (due === 0 && studied) return { reminded: false };

  setSetting('lastRemindKey', key); // 先记，避免推送失败时每分钟重发

  const body =
    due > 0 ? `有 ${due} 个词到期，去复习一下` : '今天还没背单词，先读一篇吧';
  const vapid = ensureVapid(getSetting, setSetting);
  const r = await pushAll(
    { title: '语境背单词', body, url: due > 0 ? '/review' : '/learn', tag: 'remind' },
    vapid,
  );
  return { reminded: true, due, studied, ...r };
}

/** 挂上定时器；返回一个手动触发一次的句柄（测试用）。 */
export function startScheduler() {
  const timer = setInterval(() => {
    void tick().catch(() => {
      /* 定时任务自己吞掉异常，不能让它把进程带崩 */
    });
  }, TICK_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
