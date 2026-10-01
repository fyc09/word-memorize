/**
 * 选文与复习计划。
 *
 * 这是整个应用的核心算法层，回答两个问题：
 *
 *   「学习时该给我读哪一篇？」 —— pickLearnText
 *   「复习时该给我读哪几篇？」 —— planReview（集合覆盖）
 *
 * 复习的诉求和常规背单词软件相反：不是「一次一张卡」，
 * 而是「一篇真实文本里尽量多地重逢我该复习的词」。
 * 所以这里做的是集合覆盖，而不是队列出题。
 */

import { db, parseDist } from './db.mjs';
import { dict } from './db.mjs';
import { analyzeText } from './tokenize.mjs';

/** 学习时希望落在的生词率区间（i+1 原则）。 */
const IDEAL_UNKNOWN = 0.07;
const UNKNOWN_LOW = 0.02;
const UNKNOWN_HIGH = 0.18;

/**
 * 由 dist 直接算出「以 level 为已掌握上限」时的生词率。
 * 不需要重新分词 —— 入库时已经把整篇的等级分布存下来了。
 *
 * @param {number[]} dist 7 元组，下标即等级，0 为专有名词
 * @param {number} level 用户当前等级
 */
export function unknownRate(dist, level) {
  let content = 0;
  let unknown = 0;
  for (let i = 1; i <= 6; i += 1) {
    content += dist[i];
    if (i > level) unknown += dist[i];
  }
  return { rate: content ? unknown / content : 0, content, unknown };
}

/**
 * 选一篇用于「学习」的文本。
 *
 * @param {{
 *   level?:number, categories?:string[], minWords?:number, maxWords?:number,
 *   excludeIds?:Set<number>, limit?:number, jitter?:number,
 * }} opts
 * @returns {any|null}
 */
export function pickLearnText(opts = {}) {
  const level = opts.level ?? 3;
  const minWords = opts.minWords ?? 140;
  const maxWords = opts.maxWords ?? 1200;
  const exclude = opts.excludeIds ?? new Set();
  const jitter = opts.jitter ?? 1.2;

  const rows = db
    .prepare('SELECT id, source, category, title, url, published, word_count, avg_level, dist FROM texts')
    .all();

  /** @type {{row:any, score:number}[]} */
  const scored = [];

  for (const row of rows) {
    if (exclude.has(row.id)) continue;
    if (row.word_count < minWords || row.word_count > maxWords) continue;
    if (opts.categories?.length && !opts.categories.includes(row.category)) continue;

    const dist = parseDist(row.dist);
    const { rate } = unknownRate(dist, level);
    if (rate < UNKNOWN_LOW || rate > UNKNOWN_HIGH) continue;

    // 越接近理想生词率越好；每篇再加一点随机抖动，保证不会次次都是同一篇
    let score = -Math.abs(rate - IDEAL_UNKNOWN) * 100;
    score += Math.random() * jitter;

    // 略偏好中等篇幅：太短读不过瘾，太长一次看不完
    if (row.word_count >= 200 && row.word_count <= 800) score += 1.5;

    scored.push({ row, score });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const limit = opts.limit ?? 5;
  const top = scored.slice(0, limit);
  const chosen = top[Math.floor(Math.random() * top.length)];

  return attachAnalysis(chosen.row.id);
}

/**
 * 取一篇文本并附带完整分词结果（前端渲染需要）。
 * @param {number} textId
 */
export function attachAnalysis(textId) {
  const row = db
    .prepare('SELECT id, source, category, title, url, published, word_count, avg_level, dist FROM texts WHERE id = ?')
    .get(textId);
  if (!row) return null;

  const body = db.prepare('SELECT body FROM texts WHERE id = ?').get(textId).body;
  const analysis = analyzeText(body, dict);

  return {
    ...row,
    body,
    segments: analysis.segments,
    dist: parseDist(row.dist),
  };
}

/** 挖空占位符（\u2007 是不换行空格，防止渲染时空格被吃掉）。 */
const BLANK_MARK = '\u2007______\u2007';
/** 同根词最多再遮几个，避免一句话被挖得读不下去。 */
const MAX_STEM_BLANKS = 2;

/**
 * 派生后缀。用于识别「一个是另一个的前缀，多出来的是后缀」这种同根关系。
 * sion / ssion 覆盖 -mit 动词的名词化：
 *   emit→emission  permit→permission  transmit→transmission  submit→submission
 * 这批词在学术语料里很常见，而且词干只有 3–4 个字母，靠前缀长度卡不住。
 */
const DERIV_SUFFIX =
  /^(?:s|es|ed|ing|ion|ions|tion|tions|sion|sions|ssion|ssions|ation|ations|ment|ments|ness|ness|ance|ances|ence|ences|ity|ities|ive|ives|able|ables|ible|ibles|al|ally|er|ers|or|ors|ly|ist|ists|ism|ism|ize|izes|ized|izing)$/;

/**
 * 判断两个词是否同根。
 *
 * 只遮目标词是不够的：把 predict 挖掉，句子里却留着 prediction，
 * 等于直接把答案提示出来了。同理 collaborate / collaboration。
 *
 * 两道判据满足其一即可：
 *   1. 共同前缀足够长（≥ 5 个字母，且占较短词的 60% 以上）
 *      —— 卡住 collaborate/collaboration、predict/prediction；
 *      同时避免把 part/particle、form/former 误认为同根。
 *   2. 一个是另一个的前缀（允许词干丢掉末尾一个字母），
 *      多出来的部分是公认的派生后缀
 *      —— 补上 emit/emission 这类词干太短、前缀法卡不到的。
 *
 * @param {string} a 小写原形
 * @param {string} b 小写原形
 */
function sameStem(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);

  if (n >= 5) {
    let i = 0;
    while (i < n && a[i] === b[i]) i += 1;
    if (i >= 5 && i >= Math.ceil(n * 0.6)) return true;
  }

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3) {
    const stem = short.slice(0, -1);
    if (stem.length >= 3 && long.startsWith(stem)) {
      const rest = long.slice(stem.length);
      if (DERIV_SUFFIX.test(rest)) return true;
    }
  }

  return false;
}

/**
 * 把句子里的目标词挖空，用于填空复习。
 *
 * 会挖掉该词在句中的所有出现（只挖一处会由上下文泄露答案），
 * 以及同根的派生词。
 *
 * @param {string} sentence
 * @param {string} word 目标词的原形
 * @returns {{blanked:string, answer:string, hits:number, stemHits:number}}
 */
export function makeCloze(sentence, word) {
  const target = String(word).toLowerCase();
  const { segments } = analyzeText(sentence, dict);

  // 目标词根本不在句子里就原样返回，此时遮同根词毫无意义
  const present = segments.some((s) => s.kind === 'word' && s.word === target);
  if (!present) {
    return { blanked: sentence.trim(), answer: word, hits: 0, stemHits: 0 };
  }

  let answer = null;
  let hits = 0;
  let stemHits = 0;
  let out = '';

  for (const seg of segments) {
    if (seg.kind !== 'word') {
      out += seg.text;
      continue;
    }

    if (seg.word === target) {
      if (answer === null) answer = seg.text;
      hits += 1;
      out += BLANK_MARK;
      continue;
    }

    if (stemHits < MAX_STEM_BLANKS && seg.word && sameStem(seg.word, target)) {
      stemHits += 1;
      out += BLANK_MARK;
      continue;
    }

    out += seg.text;
  }

  return {
    blanked: out.replace(/\s+/g, ' ').trim(),
    answer: answer || word,
    hits,
    stemHits,
  };
}

/**
 * 句子级噪声过滤。
 *
 * 正文提取难免会带上「订阅新闻信」「关注我们」「图片来源」这类样板句。
 * 它们确实是真实文本，但拿来做挖空或例句毫无价值
 * ——曾经出现过的坏例子：用 "Sign up for our Future Earth newsletter…" 给 climate 挖空。
 */
const BOILERPLATE =
  /(newsletter|sign ?up|subscribe|follow us|click here|read more|share this|advertis|sponsored|cookies?\b|all rights reserved|terms of (use|service)|privacy policy|getty images|image caption|photograph:|credit:|reuters\/|associated press|©)/i;

/** 句子是否适合用作挖空 / 例句。 */
function isUsableSentence(text) {
  if (!text) return false;
  if (BOILERPLATE.test(text)) return false;
  const words = text.split(/\s+/).length;
  if (words < 7 || words > 55) return false;
  // 夹带大量竖线 / 全角符号的通常是导航或表格残留
  if ((text.match(/[|▶►»]/g) || []).length > 0) return false;
  return true;
}

/** 一句适合拿来挖空的句子：长度适中，且确实含有目标词。 */
function pickSentenceFor(textId, word) {
  const rows = db
    .prepare(`
      SELECT s.id, s.text
      FROM sentences s
      JOIN sentence_words sw ON sw.sentence_id = s.id
      WHERE s.text_id = ? AND sw.word = ?
      ORDER BY s.seq
    `)
    .all(textId, word);

  const usable = rows.filter((r) => isUsableSentence(r.text));
  const pool = usable.length > 0 ? usable : [];

  let best = null;
  let bestScore = -Infinity;
  for (const r of pool) {
    const words = r.text.split(/\s+/).length;
    // 偏好 12–35 词的句子：足够给上下文，又不至于读不完
    const score = -Math.abs(words - 22);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/**
 * 制定一次复习计划。
 *
 * 思路：
 *   1. 取出到期的词（未验证过的优先，它们需要填空来确认）
 *   2. 找出所有含有这些词的文本，**排除该词当初学习时用的那篇**（用户明确要求换文本）
 *   3. 贪心集合覆盖：每轮选「新覆盖词数 / 篇幅」最高的那篇，直到覆盖完或达到上限
 *   4. 为每个词在它所属的那篇里挑一个合适句子，生成挖空题
 *
 * @param {{size?:number, maxTexts?:number, now?:Date}} opts
 */
export function planReview(opts = {}) {
  const size = opts.size ?? 12;
  const maxTexts = opts.maxTexts ?? 4;
  const now = opts.now ?? new Date();

  const due = db
    .prepare(`
      SELECT v.*, w.translation, w.phonetic, w.pos
      FROM vocab v
      LEFT JOIN words w ON w.word = v.word
      WHERE v.status != 'archived'
        AND (v.due_at IS NULL OR v.due_at <= ?)
      ORDER BY (v.due_at IS NULL) DESC, v.due_at ASC, v.reps ASC
      LIMIT ?
    `)
    .all(now.toISOString(), size);

  if (due.length === 0) {
    return { texts: [], items: [], dueCount: 0 };
  }

  const words = due.map((r) => r.word);
  const meta = new Map(due.map((r) => [r.word, r]));

  // 该词当初在哪篇文本里学的 —— 复习要尽量避开它
  const learnedIn = new Map(due.map((r) => [r.word, r.first_text_id]));

  const placeholders = words.map(() => '?').join(',');
  const pairs = db
    .prepare(`
      SELECT tw.text_id, tw.word, t.word_count, t.title, t.source, t.category
      FROM text_words tw
      JOIN texts t ON t.id = tw.text_id
      WHERE tw.word IN (${placeholders})
    `)
    .all(...words);

  /** @type {Map<number, any>} */
  const byText = new Map(); // 排除了「该词的学习原文」——首选
  /** @type {Map<number, any>} */
  const byTextAll = new Map(); // 包含学习原文——兜底

  const addTo = (map, p) => {
    let entry = map.get(p.text_id);
    if (!entry) {
      entry = {
        words: new Set(),
        word_count: p.word_count,
        title: p.title,
        source: p.source,
        category: p.category,
      };
      map.set(p.text_id, entry);
    }
    entry.words.add(p.word);
  };

  for (const p of pairs) {
    addTo(byTextAll, p);
    if (learnedIn.get(p.word) !== p.text_id) addTo(byText, p);
  }

  const remaining = new Set(words);
  /** @type {{textId:number, covered:string[], reused:boolean}[]} */
  const chosen = [];

  /**
   * 贪心集合覆盖：每轮选「新覆盖词数 / 篇幅」最高的那篇，
   * 直到覆盖完、用满配额、或再也盖不住新词。
   * @param {Map<number, any>} pool
   * @param {number} maxPicks 累计能选到第几篇（绝对值，不是本轮新增数）
   */
  const cover = (pool, maxPicks) => {
    while (remaining.size > 0 && chosen.length < maxPicks) {
      let bestId = null;
      let bestScore = 0;

      for (const [textId, entry] of pool) {
        let gain = 0;
        for (const w of entry.words) if (remaining.has(w)) gain += 1;
        if (gain === 0) continue;
        // 同样覆盖数下，偏爱短文章：读起来快，重逢密度也更高
        const score = gain / (1 + entry.word_count / 600);
        if (score > bestScore) {
          bestScore = score;
          bestId = textId;
        }
      }

      if (bestId === null) break;
      const entry = pool.get(bestId);
      const covered = [...entry.words].filter((w) => remaining.has(w));
      for (const w of covered) remaining.delete(w);
      chosen.push({ textId: bestId, covered, reused: false });
    }
  };

  // 第一轮：换用不同于学习时的文章
  cover(byText, maxTexts);

  // 第二轮：兜底。
  //
  // 生僻词（尤其 L5/L6）可能在整个语料库里只出现在它当初那篇文章里。
  // 与其把这词无限期留在队列里、永远复习不到，不如用「同一篇文章的另一个句子」
  // 来复习，并标上 reused，让界面能诚实告知用户这次没能换到新语境。
  if (remaining.size > 0) {
    const budget = chosen.length + (opts.maxTextsFallback ?? 8);
    const before = new Set(remaining);
    cover(byTextAll, budget);
    for (const c of chosen) {
      if (c.covered.some((w) => before.has(w))) c.reused = true;
    }
  }

  // 组织成前端需要的结构
  const texts = chosen.map(({ textId, covered, reused }) => {
    const row = db
      .prepare('SELECT id, source, category, title, url, published, word_count, avg_level FROM texts WHERE id = ?')
      .get(textId);
    return { ...row, covers: covered.length, targetWords: covered, reused };
  });

  /** @type {any[]} */
  const items = [];
  for (const { textId, covered, reused } of chosen) {
    for (const word of covered) {
      const sent = pickSentenceFor(textId, word);
      if (!sent) continue;
      const cloze = makeCloze(sent.text, word);

      // 整段上下文，用于「填不出来」时退回阅读模式
      const paragraph = paragraphAround(textId, sent.id);

      const m = meta.get(word);
      const reps = m?.reps ?? 0;
      let stage = 'new';
      if (reps > 0) stage = m?.verified ? 'learning' : 'reading';

      items.push({
        word,
        textId,
        sentenceId: sent.id,
        sentence: sent.text,
        blanked: cloze.blanked,
        answer: cloze.answer,
        context: paragraph,
        level: m?.level ?? 6,
        translation: m?.translation ?? null,
        phonetic: m?.phonetic ?? null,
        pos: m?.pos ?? null,
        stage,
        reps,
        lapses: m?.lapses ?? 0,
        // true 表示没能换到新语境，只能复用学习时那篇文章的另一个句子
        reusedContext: reused,
      });
    }
  }

  // 难度低的排前面，先易后难
  items.sort((a, b) => a.level - b.level);

  return { texts, items, dueCount: due.length, uncovered: remaining.size };
}

/** 取某句所在的段落（用前后各 1 句近似），作为阅读模式下的上下文。 */
function paragraphAround(textId, sentenceId) {
  const rows = db
    .prepare('SELECT id, seq, text FROM sentences WHERE text_id = ? ORDER BY seq')
    .all(textId);

  const idx = rows.findIndex((r) => r.id === sentenceId);
  if (idx < 0) return '';

  const from = Math.max(0, idx - 1);
  const to = Math.min(rows.length, idx + 2);
  return rows.slice(from, to).map((r) => r.text).join(' ');
}

/**
 * 找出「含有这个词的真实例句」。
 *
 * 这是应用的一个关键能力：点开一个词，除了词典释义，
 * 还能看到它在其它真实文章里的用法，而不是编造的例句。
 *
 * @param {string} word
 * @param {{limit?:number, excludeTextId?:number}} opts
 */
export function exampleSentences(word, opts = {}) {
  const limit = opts.limit ?? 6;
  const rows = db
    .prepare(`
      SELECT s.id, s.text, s.text_id, t.title, t.source, t.category, t.url
      FROM sentence_words sw
      JOIN sentences s ON s.id = sw.sentence_id
      JOIN texts t ON t.id = s.text_id
      WHERE sw.word = ?
      ORDER BY LENGTH(s.text) ASC
      LIMIT ?
    `)
    .all(word, limit * 4);

  const out = [];
  const seenTexts = new Set();
  for (const r of rows) {
    if (r.text_id === opts.excludeTextId) continue;
    // 每篇最多贡献一句，让例句尽量来自不同文章
    if (seenTexts.has(r.text_id)) continue;
    if (!isUsableSentence(r.text)) continue;
    seenTexts.add(r.text_id);
    out.push({
      sentenceId: r.id,
      textId: r.text_id,
      sentence: r.text,
      title: r.title,
      source: r.source,
      category: r.category,
    });
    if (out.length >= limit) break;
  }
  return out;
}
