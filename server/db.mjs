/**
 * 数据库访问层。
 *
 * 用 Node 24 内置的 node:sqlite，不引第三方驱动。
 * 词库查询带内存缓存 —— 分析一篇文章会查上千次词，缓存是必要的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { wordsPerSentence } from './tokenize.mjs';
import { ensureSchema } from './schema.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = path.join(ROOT, 'data', 'app.db');

if (!fs.existsSync(DB_PATH)) {
  throw new Error(
    `找不到数据库 ${DB_PATH}\n请先运行： npm run build:db`,
  );
}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 每次进程启动都把库升到当前 schema。
// 老库就地补表和列，不重建 —— 重建会丢掉语料。
ensureSchema(db);

// ---------------------------------------------------------------- 词库

const qWord = db.prepare(
  'SELECT word, level, phonetic, pos, translation, definition, tags, frq, bnc, collins, oxford, exchange FROM words WHERE word = ?',
);
const qWordCI = db.prepare(
  'SELECT word, level, phonetic, pos, translation, definition, tags, frq, bnc, collins, oxford, exchange FROM words WHERE word = ? COLLATE NOCASE',
);
const qLemma = db.prepare('SELECT base FROM lemma WHERE form = ?');

/** @type {Map<string, any>} */
const wordCache = new Map();
/** @type {Map<string, string|null>} */
const lemmaCache = new Map();

/**
 * 查词条。先精确匹配，再忽略大小写。
 * @param {string} word
 */
export function lookupWord(word) {
  if (wordCache.has(word)) return wordCache.get(word);
  const rec = qWord.get(word) || qWordCI.get(word) || null;
  wordCache.set(word, rec);
  return rec;
}

/**
 * 查变形词的原形。
 * @param {string} form 小写词形
 * @returns {string|null}
 */
export function lookupLemma(form) {
  if (lemmaCache.has(form)) return lemmaCache.get(form);
  const row = qLemma.get(form);
  const base = row ? row.base : null;
  lemmaCache.set(form, base);
  return base;
}

/** 供 tokenize.analyzeText 使用的词典接口。 */
export const dict = { lookupWord, lookupLemma };

// ---------------------------------------------------------------- 文本入库

const insText = db.prepare(`
  INSERT INTO texts (source, category, title, url, published, fetched_at, body, word_count, avg_level, dist, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insSentence = db.prepare('INSERT INTO sentences (text_id, seq, text) VALUES (?, ?, ?)');
const insSentenceWord = db.prepare(
  'INSERT INTO sentence_words (sentence_id, word) VALUES (?, ?) ON CONFLICT DO NOTHING',
);
const insTextWord = db.prepare(
  'INSERT INTO text_words (text_id, word, cnt, level) VALUES (?, ?, ?, ?)',
);
const qTextByUrl = db.prepare('SELECT id FROM texts WHERE url = ?');

/**
 * 把一篇分析好的文章写入库。
 *
 * @param {{
 *   source:string, category:string, title:string|null, url:string,
 *   published:string|null, body:string, analysis:any, profile:any,
 *   spans:{text:string,start:number,end:number}[],
 * }} row
 * @returns {number} text id（若已存在则返回既有 id）
 */
export function insertText(row) {
  const existing = row.url ? qTextByUrl.get(row.url) : null;
  if (existing) return existing.id;

  db.exec('BEGIN');
  try {
    const info = insText.run(
      row.source,
      row.category,
      row.title,
      row.url,
      row.published,
      new Date().toISOString(),
      row.body,
      row.profile.contentTokens,
      row.profile.avgLevel,
      JSON.stringify(row.profile.dist),
      null,
    );
    const textId = Number(info.lastInsertRowid);
    writeTextContent(textId, row);
    db.exec('COMMIT');
    return textId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const delSentenceWords = db.prepare(
  'DELETE FROM sentence_words WHERE sentence_id IN (SELECT id FROM sentences WHERE text_id = ?)',
);
const delSentences = db.prepare('DELETE FROM sentences WHERE text_id = ?');
const delTextWords = db.prepare('DELETE FROM text_words WHERE text_id = ?');
const updTextAnalysis = db.prepare(
  'UPDATE texts SET body = ?, word_count = ?, avg_level = ?, dist = ? WHERE id = ?',
);

/**
 * 把一个文本的分词结果写入索引表。
 *
 * 必须是**可重入**的：换分词器、改难度分级、修清洗规则之后，
 * 都需要拿库里已有的正文重新算一遍，而不是重新抓一遍语料
 * （重新抓只会拿到 feed 最新的几十条，语料库会缩水）。
 *
 * @param {number} textId
 * @param {{analysis:any, profile:any, spans:{text:string,start:number,end:number}[], body:string}} row
 */
export function writeTextContent(textId, row) {
  delSentenceWords.run(textId);
  delSentences.run(textId);
  delTextWords.run(textId);

  if (row.body !== undefined) {
    updTextAnalysis.run(
      row.body,
      row.profile.contentTokens,
      row.profile.avgLevel,
      JSON.stringify(row.profile.dist),
      textId,
    );
  }

  // 每句包含哪些词：按字符区间分配，不能把整篇的词挂到每一句上
  const perSentence = wordsPerSentence(row.analysis.segments, row.spans);

  row.spans.forEach((s, i) => {
    const si = insSentence.run(textId, i, s.text);
    const sid = Number(si.lastInsertRowid);
    // 句子级词索引，用于「找出包含这个词的真实例句」
    for (const w of perSentence[i]) insSentenceWord.run(sid, w);
  });

  // 文章级词索引，用于复习时的集合覆盖选文
  for (const v of row.analysis.vocab.values()) {
    insTextWord.run(textId, v.word, v.count, v.level);
  };
}

/**
 * 已入库的全部 URL（用于跳过重复抓取）。
 * @returns {Set<string>}
 */
export function knownUrls() {
  const rows = db.prepare('SELECT url FROM texts WHERE url IS NOT NULL').all();
  return new Set(rows.map((r) => r.url));
}

export function getText(id) {
  return db.prepare('SELECT * FROM texts WHERE id = ?').get(id) || null;
}

export function getSentences(textId) {
  return db.prepare('SELECT id, seq, text FROM sentences WHERE text_id = ? ORDER BY seq').all(textId);
}

export function textCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM texts').get().c;
}

const EMPTY_DIST = [0, 0, 0, 0, 0, 0, 0];

/**
 * 安全解析 dist 列（7 个等级的 token 数）。
 * 值由写入侧保证，但读侧不该因一条脏数据整体崩掉。
 * @param {unknown} raw
 * @returns {number[]}
 */
export function parseDist(raw) {
  if (typeof raw !== 'string') return EMPTY_DIST.slice();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 7) return EMPTY_DIST.slice();
    return parsed.map((n) => Number(n) || 0);
  } catch {
    return EMPTY_DIST.slice();
  }
}

// ---------------------------------------------------------------- 活动流水

const insActivity = db.prepare(
  'INSERT INTO activity (at, kind, word, text_id, detail) VALUES (?, ?, ?, ?, ?)',
);

/**
 * 追写一条活动记录。
 *
 * 全库只此一处写 activity，是设计上的约束：学习/复习/标记/抓取
 * 都走这里，不另建并行日志表 —— 两份日志早晚会对不上。
 *
 * @param {string} kind read_start | read_done | mark | unmark | review | fetch
 * @param {{word?:string|null, textId?:number|null, detail?:object}} [opts]
 */
export function logActivity(kind, opts = {}) {
  insActivity.run(
    new Date().toISOString(),
    kind,
    opts.word ?? null,
    opts.textId ?? null,
    opts.detail ? JSON.stringify(opts.detail) : null,
  );
}

// ---------------------------------------------------------------- 设置

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}
