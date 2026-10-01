/**
 * 阅读会话。
 *
 * 「当前正在读哪一篇」这个状态存在 read_texts 里（status = 'reading'），
 * 不另存一个 settings.current_text_id —— 两处状态早晚会不同步，
 * 而刷新后要恢复的其实就是那条未完成的会话本身。
 *
 * 每次 startSession 都会把上一条未完成会话标成 dropped：
 * 用户点「换一篇」就是放弃了上一篇，不该留下两条 'reading' 互相打架。
 */

import { db, logActivity, parseDist } from './db.mjs';
import { attachAnalysis } from './select.mjs';

const SESSION_COLS =
  'id, text_id, mode, started_at, finished_at, n_marked, status';

/** 当前未读完的会话，没有则 null。 */
export function currentSession() {
  return (
    db
      .prepare(
        `SELECT ${SESSION_COLS} FROM read_texts WHERE status = 'reading' ORDER BY started_at DESC LIMIT 1`,
      )
      .get() || null
  );
}

/**
 * 开始读一篇。会先放弃上一条未完成的会话。
 * @param {number} textId
 * @returns {number} session id
 */
export function startSession(textId) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE read_texts SET status = 'dropped', finished_at = ? WHERE status = 'reading'",
    ).run(now);

    const info = db
      .prepare(
        "INSERT INTO read_texts (text_id, mode, started_at, status) VALUES (?, 'learn', ?, 'reading')",
      )
      .run(textId, now);

    logActivity('read_start', { textId });
    db.exec('COMMIT');
    return Number(info.lastInsertRowid);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 把会话标为读完。
 * @param {number} sessionId
 * @param {number} nMarked
 * @param {string[]} [markedWords] 本次标记的词，存进流水，列表里可展开看详情
 */
export function finishSession(sessionId, nMarked, markedWords = []) {
  const now = new Date().toISOString();
  const session = db
    .prepare(`SELECT ${SESSION_COLS} FROM read_texts WHERE id = ?`)
    .get(sessionId);

  if (!session) throw new Error(`阅读会话 ${sessionId} 不存在`);
  if (session.status === 'done') return session;

  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE read_texts SET status = 'done', finished_at = ?, n_marked = ? WHERE id = ?",
    ).run(now, Number(nMarked) || 0, sessionId);
    logActivity('read_done', {
      textId: session.text_id,
      detail: { nMarked: Number(nMarked) || 0, words: markedWords },
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return db.prepare(`SELECT ${SESSION_COLS} FROM read_texts WHERE id = ?`).get(sessionId);
}

/** 某篇里已标记的词，按等级从高到低。 */
export function markedWordsOf(textId, withLevel = false) {
  const cols = withLevel ? 'v.word, v.level' : 'v.word';
  return db
    .prepare(`
      SELECT ${cols} FROM vocab v
      WHERE v.status != 'archived'
        AND v.word IN (SELECT word FROM text_words WHERE text_id = ?)
      ORDER BY v.level DESC, v.word
    `)
    .all(textId);
}

/** 某篇文本里已经被标记过的词（用于恢复高亮）。 */
function markedWordList(textId) {
  return markedWordsOf(textId).map((r) => r.word);
}

/**
 * 组装会话给前端：文本正文 + 分词 + 已标记词 + 难度画像。
 * @param {{text_id:number, id:number, started_at:string}} session
 * @param {number} level 用户当前水平，用来算生词率
 */
export function sessionPayload(session, level) {
  const text = attachAnalysis(session.text_id);
  if (!text) return null;

  const dist = parseDist(db.prepare('SELECT dist FROM texts WHERE id = ?').get(session.text_id)?.dist);
  let content = 0;
  let unknown = 0;
  for (let i = 1; i <= 6; i += 1) {
    content += dist[i];
    if (i > level) unknown += dist[i];
  }

  return {
    session: {
      id: session.id,
      startedAt: session.started_at,
      finishedAt: session.finished_at ?? null,
      status: session.status,
    },
    text: {
      ...text,
      unknownRate: content ? unknown / content : 0,
      unknownCount: unknown,
    },
    markedWords: markedWordList(session.text_id),
  };
}

/** 文本库列表：每篇带最近一次会话的进度。 */
export function textLibrary({ filter = 'all', limit = 100, offset = 0 } = {}) {
  const where = {
    all: '1 = 1',
    unread: 'ls.id IS NULL',
    reading: "ls.status = 'reading'",
    done: "ls.status = 'done'",
  }[filter];
  if (!where) throw new Error(`未知的筛选条件 ${filter}`);

  return db
    .prepare(`
      SELECT t.id, t.source, t.category, t.title, t.url, t.published, t.fetched_at,
             t.word_count, t.avg_level,
             ls.id          AS session_id,
             ls.status      AS status,
             ls.started_at  AS started_at,
             ls.finished_at AS finished_at,
             ls.n_marked    AS n_marked,
             (SELECT COUNT(*) FROM read_texts r WHERE r.text_id = t.id AND r.status = 'done') AS times_read
      FROM texts t
      LEFT JOIN read_texts ls
             ON ls.id = (SELECT r2.id FROM read_texts r2
                         WHERE r2.text_id = t.id
                         ORDER BY (r2.status = 'reading') DESC, r2.started_at DESC
                         LIMIT 1)
      WHERE ${where}
      ORDER BY COALESCE(ls.started_at, t.fetched_at) DESC
      LIMIT ? OFFSET ?
    `)
    .all(limit, offset);
}

/** 文本库总数（按筛选条件）。 */
export function textLibraryCount(filter = 'all') {
  const where = {
    all: '1 = 1',
    unread: 'NOT EXISTS (SELECT 1 FROM read_texts r WHERE r.text_id = t.id)',
    reading: "EXISTS (SELECT 1 FROM read_texts r WHERE r.text_id = t.id AND r.status = 'reading')",
    done: "EXISTS (SELECT 1 FROM read_texts r WHERE r.text_id = t.id AND r.status = 'done')",
  }[filter];
  return db.prepare(`SELECT COUNT(*) AS c FROM texts t WHERE ${where}`).get().c;
}
