/**
 * 构建 data/app.db：
 *   - words   : ECDICT 词库（含难度等级）
 *   - lemma   : 变形 → 原形
 *   - 文本/语料相关表（texts / sentences / text_words）
 *   - 用户状态表（vocab / encounters / reviews / read_texts / settings）
 *
 * 用法： node scripts/build-db.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../server/csv.mjs';
import { levelOf } from '../server/level.mjs';
import { SCHEMA } from '../server/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw');
const DB_PATH = path.join(DATA, 'app.db');

fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = OFF');

// schema 定义在 server/schema.mjs，与运行时的迁移共用同一份
db.exec(SCHEMA);

// ---------------------------------------------------------------- words

console.log('[1/3] 解析 ECDICT 词库 ...');
const csvText = fs.readFileSync(path.join(RAW, 'ecdict.csv'), 'utf8');

const insertWord = db.prepare(`
  INSERT INTO words (word, level, phonetic, pos, translation, definition, frq, bnc, collins, oxford, tags, exchange)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(word) DO NOTHING
`);

const SHOULD_KEEP = /^[A-Za-z][A-Za-z'’\-]*$/;

let header = null;
let scanned = 0;
let kept = 0;
const levelCounts = Array.from({ length: 7 }, () => 0);

db.exec('BEGIN');
for (const row of parseCsv(csvText)) {
  if (header === null) {
    header = row;
    continue;
  }
  scanned += 1;
  if (row.length < 13) continue;

  const word = row[0];
  if (!SHOULD_KEEP.test(word)) continue;

  const rec = {
    tag: row[7],
    frq: row[9],
    bnc: row[8],
  };
  const level = levelOf(rec);

  insertWord.run(
    word,
    level,
    row[1] || null,
    row[4] || null,
    row[3] || null,
    row[2] || null,
    Number(row[9]) || 0,
    Number(row[8]) || 0,
    Number(row[5]) || 0,
    Number(row[6]) || 0,
    row[7] || null,
    row[10] || null,
  );
  kept += 1;
  levelCounts[level] += 1;
}
db.exec('COMMIT');
console.log(`      扫描 ${scanned} 行，收录 ${kept} 个单词`);
console.log(
  '      难度分布 ' + levelCounts.map((c, i) => `L${i}:${c}`).join('  '),
);

// ---------------------------------------------------------------- lemma

console.log('[2/3] 构建变形词表 ...');

// 变形映射会打架（例如 pilot / pilote 都声称 piloting 是自己的变形，
// 又如 lemma.en.txt 自身第 15 行 i/1133697 -> my,me,we,is 把 is 挂在 i 下）。
// 用一个显式的 priority 列决定谁说了算，而不是拿 freq 兼任优先级
// —— freq 的真正含义是「原形在语料中的频次」，只用于同档内的胜负。
const P_LEMMALIST = 30; // lemma.en.txt：人工整理的词形还原表，最可信
const P_ECDICT_BASE = 20; // ECDICT exchange 的 `0:`：词条自述的原形
const P_ECDICT_INFLECT = 10; // ECDICT exchange 的变形列表

const insertLemma = db.prepare(`
  INSERT INTO lemma (form, base, freq, priority) VALUES (?, ?, ?, ?)
  ON CONFLICT(form) DO UPDATE SET
    base = excluded.base,
    freq = excluded.freq,
    priority = excluded.priority
  WHERE excluded.priority > lemma.priority
     OR (excluded.priority = lemma.priority AND excluded.freq > lemma.freq)
`);

let lemmaCount = 0;
db.exec('BEGIN');

// 来源 A：ECDICT 自带的 exchange 字段。
//
// 字段格式是 `键:值` 用 `/` 分隔，键的含义：
//   p 过去式   d 过去分词   i 现在分词   3 第三人称单数   s 复数   r 比较级   t 最高级
//   0 **本词条的原形**（方向相反！）   1 变形类型代码（如 s3），不是词形，必须跳过
//
// 关键：A 类键表示「本词条的变形」，方向是 变形 → 本词条；
// 而 `0:` 表示「本词条是某个词条的变形」，方向是 本词条 → 那个词。
// 把 `0:` 当成 A 类处理会把方向弄反，导致 pilot→pilots、be→been 这种
// 把常用词映射到自己的变形上去的错乱（变体词无考纲标签且 frq=0，会被误判成「难」）。
const allWords = db
  .prepare("SELECT word, exchange FROM words WHERE exchange IS NOT NULL AND exchange != ''")
  .all();

// ECDICT 里同一个变形可能被多个词条认领（pilot / pilote 都声称 piloting 是自己的变形），
// 用原形的词频排名做同档内的胜负判定：越常见的原形越可信。
//
// 这里一次性把全部词频加载成 Map。早先写成每词一次 SQL 查询的做法会退化成
// 40 万次全表扫描（COLLATE NOCASE 用不上主键索引），直接跑到超时。
const rankByWord = new Map();
for (const r of db.prepare('SELECT word, frq, bnc FROM words').iterate()) {
  const frq = Number(r.frq) || 0;
  const bnc = Number(r.bnc) || 0;
  const rank = frq > 0 ? frq : bnc;
  if (rank <= 0) continue;
  const key = String(r.word).toLowerCase();
  const prev = rankByWord.get(key);
  if (prev === undefined || rank < prev) rankByWord.set(key, rank);
}

/**
 * 取词条的词频排名（越小越常见），0 表示无排名。
 * @param {string} word
 */
function lookupRank(word) {
  return rankByWord.get(word) || 0;
}

for (const { word, exchange } of allWords) {
  const head = word.toLowerCase();
  for (const part of String(exchange).split('/')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;

    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).toLowerCase().trim();
    if (!val || val === head) continue;
    if (!SHOULD_KEEP.test(val)) continue;

    if (key === '1') continue; // 变形类型代码，不是词形

    if (key === '0') {
      // 本词条 → 它的原形
      insertLemma.run(head, val, 0, P_ECDICT_BASE);
    } else {
      // 本词条的变形 → 本词条；用原形的频次做同档内的胜负判定
      const rank = lookupRank(head);
      const score = rank > 0 ? 1_000_000 - Math.min(rank, 999_999) : 1;
      insertLemma.run(val, head, score, P_ECDICT_INFLECT);
    }
    lemmaCount += 1;
  }
}

// 来源 B：lemma.en.txt —— 格式为 `run/44715 -> running,ran,runs`
const lemmaFile = path.join(RAW, 'lemma.en.txt');
if (fs.existsSync(lemmaFile)) {
  for (const line of fs.readFileSync(lemmaFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith(';')) continue;
    const arrow = t.indexOf('->');
    if (arrow < 0) continue;
    const head = t.slice(0, arrow).trim();
    const body = t.slice(arrow + 2).trim();

    const slash = head.lastIndexOf('/');
    const base = (slash > 0 ? head.slice(0, slash) : head).trim().toLowerCase();
    const freq = slash > 0 ? Number(head.slice(slash + 1)) || 0 : 0;
    if (!SHOULD_KEEP.test(base)) continue;

    for (const raw of body.split(',')) {
      const form = raw.trim().toLowerCase();
      if (!form || form === base) continue;
      if (!SHOULD_KEEP.test(form)) continue;
      insertLemma.run(form, base, freq, P_LEMMALIST);
      lemmaCount += 1;
    }
  }
}
db.exec('COMMIT');
const lemmaRows = db.prepare('SELECT COUNT(*) AS c FROM lemma').get().c;
console.log(`      写入 ${lemmaCount} 条映射，去重后 ${lemmaRows} 个变形`);

// ---------------------------------------------------------------- 变形表自检
//
// 变形映射一旦方向弄反，后果是静默的：查询仍然能命中，
// 但会把常用词引向它的生僻变形，导致难度分级整体失真。
// 所以这里做一次不可跳过的断言。

// 值可以是单个期望原形，或一组可接受的原形。
//
// 用集合的地方是上游数据本身就歧义的，不是我们在将就错误：
// better/best 既是 good 的比较级，也是 well 的比较级，两份词表各执一词，
// 断言只需保证它没被挂到自己的生僻异体上。
const EXPECT_LEMMA = {
  ran: 'run', running: 'run', runs: 'run',
  geese: 'goose', mice: 'mouse', children: 'child',
  better: ['good', 'well'], best: ['good', 'well'],
  abandoned: 'abandon', abandoning: 'abandon',
  pilots: 'pilot', piloting: 'pilot', piloted: 'pilot',
  been: 'be', was: 'be', is: 'be', being: 'be',
  knew: 'know', known: 'know', knows: 'know',
  opened: 'open', opening: 'open',
  made: 'make', making: 'make',
  heroes: 'hero', attackers: 'attacker', attacked: 'attack',
  studies: 'study', studied: 'study',
};

let lemmaFail = 0;
for (const [form, want] of Object.entries(EXPECT_LEMMA)) {
  const acceptable = Array.isArray(want) ? want : [want];
  const got = db.prepare('SELECT base FROM lemma WHERE form = ?').get(form);
  if (!got || !acceptable.includes(got.base)) {
    console.error(
      `      ✗ ${form} 应为 ${acceptable.join(' 或 ')}，实为 ${got ? got.base : '(缺失)'}`,
    );
    lemmaFail += 1;
  }
}
if (lemmaFail > 0) {
  throw new Error(`变形表自检失败 ${lemmaFail} 项，数据库不可用`);
}
console.log(`      变形表自检通过（${Object.keys(EXPECT_LEMMA).length} 项）`);

// ---------------------------------------------------------------- 校验

console.log('[3/3] 校验 ...');
const checks = [
  'the', 'run', 'abandon', 'ubiquitous', 'photosynthesis', 'algorithm',
  'mitochondria', 'quantum', 'apple', 'ephemeral', 'serotonin',
];
const q = db.prepare('SELECT word, level, tags, translation FROM words WHERE word = ?');
const lq = db.prepare('SELECT base FROM lemma WHERE form = ?');
for (const w of checks) {
  const r = q.get(w);
  const lem = lq.get(w);
  const tr = r?.translation ? r.translation.split('\\n')[0].slice(0, 26) : '(无)';
  console.log(
    `      ${w.padEnd(16)} L${r ? r.level : '?'}  ${String(r?.tags ?? '').padEnd(30)} ${tr}` +
      (lem ? `   [变形→${lem.base}]` : ''),
  );
}
for (const f of ['ran', 'running', 'geese', 'better', 'abandoned', 'mice']) {
  const l = lq.get(f);
  console.log(`      变形 ${f.padEnd(12)} → ${l ? l.base : '(未收录)'}`);
}

db.close();
console.log(`\n完成 → ${DB_PATH}  (${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB)`);
