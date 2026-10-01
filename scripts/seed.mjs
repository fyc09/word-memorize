/**
 * 预置语料。
 *
 * 应用本身支持按需实时抓取新闻，但复习环节需要一批「可用于复习」的文本，
 * 而且例句索引也需要有底料，所以这里预抓一批入库。
 *
 * 用法：
 *   node scripts/seed.mjs                 # 每个题材补 8 篇
 *   node scripts/seed.mjs --fresh         # 先清空文本库再抓
 *   node scripts/seed.mjs --per=15        # 每个题材补 15 篇
 *   node scripts/seed.mjs --cat=science   # 只抓科普
 */

import { db, parseDist, textCount } from '../server/db.mjs';
import { ensurePool } from '../server/ingest.mjs';
import { CATEGORIES, FEEDS } from '../server/feeds.mjs';
import { LEVELS } from '../server/level.mjs';

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const perArg = args.find((a) => a.startsWith('--per='));
const catArg = args.find((a) => a.startsWith('--cat='));

const per = perArg ? Number(perArg.split('=')[1]) || 8 : 8;
const categories = catArg
  ? catArg.split('=')[1].split(',').filter((c) => CATEGORIES[c])
  : Object.keys(CATEGORIES);

if (fresh) {
  console.log('清空文本库 ...');
  db.exec('DELETE FROM sentence_words');
  db.exec('DELETE FROM sentences');
  db.exec('DELETE FROM text_words');
  db.exec('DELETE FROM texts');
  db.exec('DELETE FROM encounters');
  db.exec('DELETE FROM read_texts');
}

console.log(`目标题材: ${categories.map((c) => CATEGORIES[c].name).join(' / ')}`);
console.log(`库内现有文本: ${textCount()}\n`);

const t0 = Date.now();
let totalIngested = 0;

// 单次调用会被「每源最多几篇」限制住，想要更大的语料就得多轮拉扯。
// 每轮都会跳过已入库的 URL，所以会逐步往 feed 更深处走。
for (const cat of categories) {
  let got = 0;
  let scannedTotal = 0;
  let failedTotal = 0;

  for (let round = 1; round <= 8 && got < per; round += 1) {
    const before = textCount();
    const r = await ensurePool({
      categories: [cat],
      want: Math.min(12, per - got),
      perFeed: 12,
      maxPerFeed: 4,
      concurrency: 6,
    });
    const delta = textCount() - before;
    got += delta;
    scannedTotal += r.scanned;
    failedTotal += r.failed;
    if (delta === 0) break;
  }

  totalIngested += got;
  console.log(
    `${CATEGORIES[cat].name.padEnd(4)} 扫描 ${String(scannedTotal).padStart(4)} 条候选 → 入库 ${got} 篇` +
      (failedTotal ? `（${failedTotal} 条提取失败被丢弃）` : ''),
  );
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n共新增 ${totalIngested} 篇，用时 ${secs}s，库内总计 ${textCount()} 篇\n`);

// ---------------------------------------------------------------- 汇总

const rows = db
  .prepare('SELECT id, source, category, title, word_count, avg_level, dist FROM texts ORDER BY id')
  .all();

const grand = [0, 0, 0, 0, 0, 0, 0];
console.log('入库文本：');
for (const r of rows) {
  const d = parseDist(r.dist);
  for (let i = 0; i < 7; i += 1) grand[i] += d[i];
  const tot = d.reduce((a, b) => a + b, 0) || 1;
  const pct = (i) => String(Math.round((d[i] / tot) * 100)).padStart(2);
  const bars = d.map((_, i) => `${LEVELS[i].short}${pct(i)}`).join(' ');
  console.log(
    `  #${String(r.id).padStart(3)} ${r.category.padEnd(8)} ${String(r.word_count).padStart(4)}w ` +
      `均L${r.avg_level.toFixed(1)} | ${bars} | ${String(r.title || '').slice(0, 40)}`,
  );
}

const gtot = grand.reduce((a, b) => a + b, 0) || 1;
console.log('\n全库 token 难度分布（0=专有名词，不计入难度）：');
for (let i = 0; i < 7; i += 1) {
  const pct = (grand[i] / gtot) * 100;
  const bar = '█'.repeat(Math.round(pct / 1.5));
  console.log(`  L${i} ${LEVELS[i].name.padEnd(5)} ${pct.toFixed(1).padStart(5)}%  ${bar}`);
}

// 各题材覆盖的源
console.log('\n题材 × 源：');
const byCat = new Map();
for (const r of rows) {
  if (!byCat.has(r.category)) byCat.set(r.category, new Set());
  byCat.get(r.category).add(r.source);
}
for (const [cat, set] of byCat) {
  console.log(`  ${CATEGORIES[cat].name.padEnd(4)} ${[...set].join('、')}`);
}

const unusedFeeds = FEEDS.filter(
  (f) => (catArg ? categories.includes(f.category) : true) &&
    !rows.some((r) => r.source === f.name),
);
if (unusedFeeds.length) {
  console.log('\n未产出内容的源：');
  for (const f of unusedFeeds) {
    console.log(`  ${f.name.padEnd(22)} ${f.note || '(正文提取失败或条目已读)'}`);
  }
}

db.close();
