/**
 * 造一份「看起来像真在用」的演示数据，用来生成 README 截图。
 *
 * 不走 API 而是直接写库：需要的是**可控的分布** —— 四种阶段各几条、
 * 时间铺开两周、当前正在读的那篇要已经标了几个词。
 * 这些靠手动点出来既慢又不稳定，每次截图还会不一样。
 *
 * 只重写 vocab / read_texts / activity 三张用户数据表，
 * 语料、词库、设置都不动。跑之前先清空这三张表。
 *
 *   node scripts/seed-demo.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const db = new DatabaseSync(join(ROOT, 'data', 'app.db'));

const DAY = 86400000;
const now = Date.now();
const ago = (days) => new Date(now - days * DAY).toISOString();

/** 想要的状态分布：写进 vocab 的就是这几个字段。 */
const STAGES = [
  // [阶段, 条数, reps, verified, interval_days]
  ['new', 4, 0, 0, 0],
  ['reading', 3, 2, 0, 1.4],
  ['learning', 5, 4, 1, 6.2],
  ['mature', 2, 7, 1, 34],
];

// ---------------------------------------------------------------- 清空用户数据

for (const t of ['activity', 'read_texts', 'vocab']) db.prepare(`DELETE FROM ${t}`).run();
db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('activity','read_texts')").run();

// ---------------------------------------------------------------- 挑文章

/** 中等篇幅、标题像人话的文章好上镜；按来源分散一点。 */
const articles = db
  .prepare(
    `SELECT id, source, title, word_count FROM texts
     WHERE word_count BETWEEN 220 AND 620 AND title IS NOT NULL AND title != ''
     GROUP BY source
     ORDER BY word_count DESC
     LIMIT 8`,
  )
  .all();

if (articles.length < 5) {
  console.error('语料不足（先跑 npm run seed 抓一批）');
  process.exit(1);
}

const current = articles[0];
const finished = articles.slice(1);

// 一篇「正在读」，其余是过去两周读完的。
db.prepare(
  `INSERT INTO read_texts (text_id, mode, started_at, finished_at, n_marked, status)
   VALUES (?, 'learn', ?, NULL, 0, 'reading')`,
).run(current.id, ago(0.04));

finished.forEach((a, i) => {
  const started = ago(13 - i * 2);
  const done = ago(13 - i * 2 - 0.15);
  db.prepare(
    `INSERT INTO read_texts (text_id, mode, started_at, finished_at, n_marked, status)
     VALUES (?, 'learn', ?, ?, 0, 'done')`,
  ).run(a.id, started, done);
});

// ---------------------------------------------------------------- 挑词

/** 这篇文章里某个词的第一个句子（顺带给记录当「原句」）。 */
const sentenceOf = db.prepare(`
  SELECT s.id FROM sentence_words sw
  JOIN sentences s ON s.id = sw.sentence_id
  WHERE sw.word = ? AND s.text_id = ?
  ORDER BY LENGTH(s.text) ASC LIMIT 1
`);

/** 只要词典里有释义的词 —— 截图里空空一片不好看。 */
const pickWords = (textId, need) =>
  db
    .prepare(
      `SELECT tw.word, tw.level FROM text_words tw
       JOIN words w ON w.word = tw.word
       WHERE tw.text_id = ? AND tw.level BETWEEN 3 AND 6
         AND w.translation IS NOT NULL AND LENGTH(w.translation) > 4
         AND EXISTS (SELECT 1 FROM sentence_words sw WHERE sw.word = tw.word)
       -- frq 是词频排名（越小越常见），升序才是先拿常见词。
       -- 排在前面的是最生僻的词，标出来的东西不像真人会去学的。
       ORDER BY (w.frq > 0) DESC, w.frq ASC
       LIMIT ?`,
    )
    .all(textId, need);

// 当前这篇多标几个（正文下方的列表要满），读完的每篇一两个。
const plan = [
  ...pickWords(current.id, 5).map((w) => ({ ...w, textId: current.id, atDays: 0.03 })),
  ...finished.flatMap((a, i) =>
    pickWords(a.id, 2).map((w) => ({ ...w, textId: a.id, atDays: 12 - i * 2 })),
  ),
];

// ---------------------------------------------------------------- 写词与流水

const insVocab = db.prepare(`
  INSERT INTO vocab (word, level, status, first_text_id, first_sentence_id,
                     created_at, ease, interval_days, due_at, reps, lapses,
                     verified, last_mode, last_grade, last_seen_at)
  VALUES (?, ?, 'learning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insAct = db.prepare(
  'INSERT INTO activity (at, kind, word, text_id, detail) VALUES (?, ?, ?, ?, ?)',
);

const seen = new Set();
let stageIdx = 0;
let stageLeft = STAGES[0][1];

for (const p of plan) {
  if (seen.has(p.word)) continue;
  seen.add(p.word);

  // 按计划轮流分配阶段，保证四种状态都出现
  while (stageLeft === 0 && stageIdx < STAGES.length - 1) {
    stageIdx += 1;
    stageLeft = STAGES[stageIdx][1];
  }
  stageLeft -= 1;
  const [, , reps, verified, interval] = STAGES[stageIdx];

  const sid = sentenceOf.get(p.word, p.textId)?.id ?? null;
  const created = ago(p.atDays);
  const lastSeen = reps > 0 ? ago(Math.max(0.02, p.atDays - 0.5)) : null;

  insVocab.run(
    p.word,
    p.level,
    p.textId,
    sid,
    created,
    2.5,
    interval,
    /*
     * 已掌握的几个留到未来，其余都置为「已到期」——
     * 复习页要截得出来，得有题可出（stageOf 看的是 interval_days，
     * 所以改 due_at 不会把阶段弄乱）。
     */
    new Date(now + (verified && interval >= 21 ? 3 : -0.1) * DAY).toISOString(),
    reps,
    reps >= 6 ? 1 : 0,
    verified,
    reps > 0 ? 'cloze' : null,
    reps > 0 ? (verified ? 'cloze_good' : 'reading_good') : null,
    lastSeen,
  );

  insAct.run(created, 'mark', p.word, p.textId, JSON.stringify({ sentenceId: sid }));

  // 复习记录：只给已有进度的词，让「记录」看起来是活的
  for (let r = 0; r < reps; r += 1) {
    const at = ago(Math.max(0.01, p.atDays - 0.4 - r * 0.9));
    const good = verified ? r % 3 !== 2 : false;
    insAct.run(
      at,
      'review',
      p.word,
      p.textId,
      JSON.stringify({
        mode: verified ? 'cloze' : 'reading',
        grade: verified ? (good ? 'cloze_good' : 'cloze_fuzzy') : 'reading_good',
        typed: verified && good ? p.word : null,
        usedHint: false,
        sentenceId: sid,
        prev: r === 0 ? 0 : Number((interval / 2).toFixed(1)),
        next: interval,
      }),
    );
  }
}

// 读完流水的 n_marked 与 read_done 记录
for (const a of finished) {
  const n = db
    .prepare("SELECT COUNT(*) c FROM vocab WHERE first_text_id = ?").get(a.id).c;
  db.prepare("UPDATE read_texts SET n_marked = ? WHERE text_id = ? AND status = 'done'").run(
    n,
    a.id,
  );
  insAct.run(
    ago(12 - finished.indexOf(a) * 2 - 0.1),
    'read_done',
    null,
    a.id,
    JSON.stringify({
      nMarked: n,
      words: db
        .prepare('SELECT word FROM vocab WHERE first_text_id = ? LIMIT 8')
        .all(a.id)
        .map((r) => r.word),
    }),
  );
}

// 当前这篇的 read_start
insAct.run(ago(0.04), 'read_start', null, current.id, null);

// ---------------------------------------------------------------- 结果

const byStage = db
  .prepare(
    `SELECT CASE
        WHEN reps = 0 THEN '新词'
        WHEN verified = 0 THEN '待验证'
        WHEN interval_days >= 21 THEN '已掌握'
        ELSE '学习中' END AS s, COUNT(*) n
     FROM vocab GROUP BY s`,
  )
  .all();
console.log('演示数据已写入');
console.log('  文章: ' + articles.length + ' 篇（1 在读 / ' + finished.length + ' 已读）');
console.log('  生词: ' + seen.size + ' 个 → ' + byStage.map((r) => r.s + ' ' + r.n).join(' · '));
console.log('  流水: ' + db.prepare('SELECT COUNT(*) c FROM activity').get().c + ' 条');
