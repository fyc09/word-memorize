/**
 * 词汇难度分级。
 *
 * ECDICT 里只有 14,942 个词带考试标签（zk/gk/cet4/cet6/ky/ielts/toefl/gre），
 * 其余 75 万词完全没有标签，所以难度必须做「标签优先 + 词频兜底」的复合判定。
 *
 * 输出的 level 语义：
 *   0  = 非词汇（专有名词 / 缩写 / 数字 / 标点），不计入文本难度
 *   1  = 简单     (中考 zk / 高考 gk / 词频极高)
 *   2  = 四级     cet4
 *   3  = 六级     cet6
 *   4  = 考研     ky
 *   5  = 进阶     ielts / toefl
 *   6  = 难       gre / 无标签且低频
 */

/**
 * 难度分级。
 *
 * 颜色**不在这里定义** —— 它是纯展示层的概念，而且深/浅主题各需一套调子。
 * 颜色的唯一来源是 src/styles.css 里的 --lv0 … --lv6，
 * 前端图例与徽标都引用 var(--lvN)。
 */
export const LEVELS = [
  { level: 0, key: 'propn', name: '专有名词', short: '专' },
  // L1 用正文本色：阅读时「没有颜色」就等于「简单」，
  // 同时省掉给 77% 的文字上色这件事。
  { level: 1, key: 'basic', name: '简单', short: '简' },
  { level: 2, key: 'cet4', name: '四级', short: '四' },
  { level: 3, key: 'cet6', name: '六级', short: '六' },
  { level: 4, key: 'ky', name: '考研', short: '研' },
  { level: 5, key: 'adv', name: '雅思托福', short: '雅' },
  { level: 6, key: 'hard', name: '难', short: '难' },
];

/** tag → 难度等级的映射表。 */
const TAG_LEVEL = {
  zk: 1,
  gk: 1,
  cet4: 2,
  cet6: 3,
  ky: 4,
  ielts: 5,
  toefl: 5,
  gre: 6,
};

/**
 * 词频兜底分级。
 * 只在词条完全没有考试标签时使用。
 * @param {number} rank 词频排名（越小越常见），0 表示无排名
 */
function levelFromRank(rank) {
  if (!rank || rank <= 0) return 6; // 无排名 → 视为生僻
  if (rank <= 3000) return 1;
  if (rank <= 6000) return 4;
  if (rank <= 12000) return 5;
  if (rank <= 20000) return 5;
  return 6;
}

/**
 * 由 ECDICT 词条计算难度等级。
 * @param {{ tag?: string, frq?: string|number, bnc?: string|number }|null|undefined} rec
 * @returns {number} 0-6
 */
export function levelOf(rec) {
  if (!rec) return 6;

  const tags = String(rec.tag || '').split(/\s+/).filter(Boolean);

  // 取**最早**出现的考纲档位，而不是最高档。
  // 语义是「这个词从哪一级开始就该会了」——即考纲归属。
  // 例如 abandon 带 gk+cet4+cet6+ky+toefl+gre，它是一级词而非 GRE 词，
  // 因为高考就该掌握它。若取最高档，几乎全部四级词都会被算成「难」。
  let best = 0;
  for (const t of tags) {
    const lv = TAG_LEVEL[t];
    if (lv && (best === 0 || lv < best)) best = lv;
  }
  if (best > 0) return best;

  const frq = Number(rec.frq) || 0;
  const bnc = Number(rec.bnc) || 0;
  // frq 与 bnc 都是排名，取更可靠的一个：优先 frq，次选 bnc。
  const rank = frq > 0 ? frq : bnc;
  return levelFromRank(rank);
}

/** 判断一个 token 是否为纯字母词（含内部连字符 / 撇号）。 */
export function isWordToken(tok) {
  return /^[A-Za-z][A-Za-z'’-]*$/.test(tok);
}

/** 全大写缩写，如 NASA / DNA / COVID。 */
export function isAcronym(tok) {
  return /^[A-Z]{2,}$/.test(tok);
}

/**
 * 专有名词启发式判定。
 *
 * 判据：句中（非句首）出现过首字母大写的形式，且不属于常见词汇。
 * 这样 "Dakota"、"Trump"、"Kubernetes" 会被识别为专有名词，
 * 而句首大写的 "The" / "However" 不会。
 *
 * @param {{ capitalizedMid: boolean, level: number, acronym: boolean }} info
 */
export function isProperNoun(info) {
  if (info.acronym) return true;
  return info.capitalizedMid && info.level >= 5;
}
