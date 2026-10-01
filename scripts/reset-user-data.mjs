/**
 * 清空用户学习数据，保留语料库与词库。
 *
 * 用途：把应用交给别人用、或想从零开始学一遍时，不用重新抓语料
 * （重抓只会拿到 feed 最新的几十条，语料库会大幅缩水）。
 *
 * 用法： node scripts/reset-user-data.mjs [--corpus]
 *   --corpus  连语料库一起清空（下次进应用会现场抓取）
 *
 * 保留的：words / lemma（词库）、texts 系列（语料）、settings（水平与题材偏好）
 */

import { db, textCount } from '../server/db.mjs';

const alsoCorpus = process.argv.includes('--corpus');

const count = (sql) => db.prepare(sql).get().c;
const before = {
  vocab: count('SELECT COUNT(*) c FROM vocab'),
  activity: count('SELECT COUNT(*) c FROM activity'),
  readTexts: count('SELECT COUNT(*) c FROM read_texts'),
  jobs: count('SELECT COUNT(*) c FROM jobs'),
  texts: textCount(),
};

db.exec('BEGIN');
// 顺序无所谓（没有外键约束），但语义上先清派生状态再清流水
db.exec('DELETE FROM vocab');
db.exec('DELETE FROM read_texts');
db.exec('DELETE FROM activity');
db.exec('DELETE FROM jobs');
if (alsoCorpus) {
  db.exec('DELETE FROM sentence_words');
  db.exec('DELETE FROM sentences');
  db.exec('DELETE FROM text_words');
  db.exec('DELETE FROM texts');
}
db.exec('COMMIT');

console.log('已清空用户数据：');
console.log(`  生词       ${before.vocab} → 0`);
console.log(`  阅读会话   ${before.readTexts} → 0`);
console.log(`  活动流水   ${before.activity} → 0`);
console.log(`  后台任务   ${before.jobs} → 0`);
if (alsoCorpus) console.log(`  语料库     ${before.texts} → 0`);
else console.log(`  语料库     ${before.texts} 篇（保留）`);
console.log('  词库与设置（保留）');
