/**
 * 后台任务。
 *
 * 为什么要有这一层：抓取一篇语料要 1–2 秒，抓十几篇就是几十秒，
 * 而 nginx 会把超时的长请求直接掐断 —— 所以 HTTP 层必须立刻返回，
 * 真正的抓取在后台继续跑。
 *
 * 状态存数据库而不是内存，这样刷新页面后还能看到「正在抓取」，
 * 而任务其实还在跑。刷新恢复的正是这条 jobs 记录。
 */

import { db, logActivity } from './db.mjs';
import { ensurePool } from './ingest.mjs';

const JOB_COLS = 'id, kind, status, started_at, finished_at, progress, result, error';

/** @param {number} id */
export function getJob(id) {
  const row = db.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE id = ?`).get(id);
  return row ? shape(row) : null;
}

/** 某类任务最近一条（不论状态）。 */
export function latestJob(kind = 'fetch') {
  const row = db
    .prepare(`SELECT ${JOB_COLS} FROM jobs WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get(kind);
  return row ? shape(row) : null;
}

/** 某类任务正在跑的那条。 */
export function runningJob(kind = 'fetch') {
  const row = db
    .prepare(
      `SELECT ${JOB_COLS} FROM jobs WHERE kind = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get(kind);
  return row ? shape(row) : null;
}

function shape(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    progress: safeJson(row.progress),
    result: safeJson(row.result),
    error: row.error,
  };
}

function safeJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 启动一次抓取。
 *
 * 已有同名任务在跑时直接复用，不重复起 —— 用户连点两次不该抓两遍。
 *
 * @param {{categories?:string[], want?:number}} opts
 * @returns {{job:any, alreadyRunning:boolean}}
 */
export function startFetchJob(opts = {}) {
  const existing = runningJob('fetch');
  if (existing) return { job: existing, alreadyRunning: true };

  const now = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO jobs (kind, status, started_at, progress) VALUES ('fetch', 'running', ?, ?)",
    )
    .run(now, JSON.stringify({ phase: 'listing', ingested: 0 }));
  const id = Number(info.lastInsertRowid);

  // 故意不 await：HTTP 层立刻返回，抓取在后台继续。
  void executeFetch(id, opts);

  return { job: getJob(id), alreadyRunning: false };
}

async function executeFetch(id, { categories, want = 12 }) {
  try {
    const result = await ensurePool({
      categories,
      want,
      perFeed: 12,
      maxPerFeed: 4,
      concurrency: 6,
    });
    db.prepare(
      "UPDATE jobs SET status = 'done', finished_at = ?, result = ?, progress = NULL WHERE id = ?",
    ).run(new Date().toISOString(), JSON.stringify(result), id);
    logActivity('fetch', { detail: result });
  } catch (err) {
    db.prepare(
      "UPDATE jobs SET status = 'error', finished_at = ?, error = ?, progress = NULL WHERE id = ?",
    ).run(new Date().toISOString(), String(err?.message ?? err), id);
  }
}

/**
 * 进程启动时清理僵尸任务。
 *
 * 服务被杀掉时正在跑的 job 会永远停在 'running'，界面就会一直显示
 * 「正在抓取」且按钮永久不可用。启动时把它们标成中断即可自愈。
 */
export function reapStaleJobs() {
  const n = db
    .prepare(
      "UPDATE jobs SET status = 'error', finished_at = ?, error = '进程中断' WHERE status = 'running'",
    )
    .run(new Date().toISOString());
  return Number(n.changes ?? 0);
}
