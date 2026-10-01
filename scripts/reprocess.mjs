/**
 * 用当前的分词器 / 难度分级 / 文本清洗规则，重算库里已有文本的索引。
 *
 * 什么时候需要它：
 *   - 改了难度分级（比如修好 lemma 表的方向问题之后）
 *   - 改了分词或清洗规则（比如开始剥离 LaTeX 残留）
 *   - 修了缩写还原
 *
 * 为什么不能简单地重新抓一遍语料：
 *   feed 只暴露最近几十条，重抓会让语料库缩水（本来 122 篇，重抓只剩 40 篇）。
 *   正文已经存在库里了，直接重算是无损且快得多的做法。
 *
 * 用法：
 *   node scripts/reprocess.mjs              # 用库里已有的正文重算索引
 *   node scripts/reprocess.mjs --refetch    # 先重新抓取文章页再重算
 *
 * --refetch 的用途：正文清洗规则改好之后（比如开始处理粘连词、分离内联标签），
 * 库里存的旧正文已经是脏的，重算救不回来，必须回源重取。
 * 能抓不到的条目会保留原正文继续重算，不会丢语料。
 */

import { db, textCount, writeTextContent } from '../server/db.mjs';
import { extractArticle, normalizeSourceText } from '../server/extract.mjs';
import { fetchText } from '../server/fetch.mjs';
import { analyzeText, splitSentenceSpans, textProfile } from '../server/tokenize.mjs';
import { dict } from '../server/db.mjs';
import { LEVELS } from '../server/level.mjs';
import { englishStats } from '../server/lang.mjs';
import { pool } from '../server/fetch.mjs';

const refetch = process.argv.includes('--refetch');

const before = db.prepare('SELECT COUNT(*) c FROM text_words').get().c;
const rows = db.prepare('SELECT id, body, url FROM texts ORDER BY id').all();
console.log(`重算 ${rows.length} 篇文本的分词索引${refetch ? '（含回源重取正文）' : ''} ...`);

// 回源重取正文：并发 6，失败的保留原正文
const freshBodies = new Map();
if (refetch) {
  const results = await pool(rows, 6, async (r) => {
    if (!r.url) return null;
    const html = await fetchText(r.url, 25000);
    if (!html) return null;
    const ex = extractArticle(html);
    return ex ? { id: r.id, text: ex.text } : null;
  });
  for (const res of results) if (res) freshBodies.set(res.id, res.text);
  console.log(`  回源成功 ${freshBodies.size} / ${rows.length} 篇`);
}

let updated = 0;
let dropped = 0;
let skippedLang = 0;
const distBefore = Array.from({ length: 7 }, () => 0);
const distAfter = Array.from({ length: 7 }, () => 0);

// 先统计旧分布
for (const r of db.prepare('SELECT dist FROM texts').all()) {
  try {
    const d = JSON.parse(r.dist);
    if (Array.isArray(d) && d.length === 7) d.forEach((n, i) => (distBefore[i] += Number(n) || 0));
  } catch {
    /* 脏数据忽略 */
  }
}

for (const { id, body } of rows) {
  const text = normalizeSourceText(freshBodies.get(id) ?? body ?? '');
  if (!text) {
    dropped += 1;
    continue;
  }

  const analysis = analyzeText(text, dict);
  const profile = textProfile(analysis.vocab);
  const spans = splitSentenceSpans(text);

  // 清洗后可能不再像英语（例如整页都是公式），这种直接跳过不动
  if (spans.length < 3 || profile.contentTokens < 60 || !englishStats(analysis.segments).ok) {
    skippedLang += 1;
    continue;
  }

  db.exec('BEGIN');
  try {
    writeTextContent(id, { body: text, analysis, profile, spans });
    db.exec('COMMIT');
    updated += 1;
    profile.dist.forEach((n, i) => (distAfter[i] += n));
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`  #${id} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

const after = db.prepare('SELECT COUNT(*) c FROM text_words').get().c;
console.log(`完成：重算 ${updated} 篇，跳过 ${skippedLang} 篇，清空 ${dropped} 篇`);
console.log(`索引条目 ${before} → ${after}`);
console.log(`语料总数 ${textCount()} 篇\n`);

const fmt = (arr) => {
  const tot = arr.reduce((a, b) => a + b, 0) || 1;
  return arr.map((n, i) => `${LEVELS[i].short}${((n / tot) * 100).toFixed(1)}`).join('  ');
};
console.log('token 难度分布:');
console.log(`  重算前  ${fmt(distBefore)}`);
console.log(`  重算后  ${fmt(distAfter)}`);

db.close();
