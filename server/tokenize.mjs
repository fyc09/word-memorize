/**
 * 分词器：把一段真实文本切成可渲染的片段，并标注每个词的词典信息。
 *
 * 输出是**覆盖整段文本**的片段序列（word / other 交替），
 * 前端可以直接顺序渲染，不需要自己做偏移对齐。
 */

import { isWordToken, isAcronym } from './level.mjs';

/** 匹配英文单词，允许内部连字符与撇号（如 well-known / don't / it's）。 */
const WORD_RE = /[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]/g;

/**
 * 把文本切成片段。
 * @param {string} text
 * @returns {{kind:'word'|'other', text:string, start:number, end:number}[]}
 */
export function splitSegments(text) {
  /** @type {{kind:'word'|'other', text:string, start:number, end:number}[]} */
  const segs = [];
  let last = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text)) !== null) {
    if (m.index > last) {
      segs.push({ kind: 'other', text: text.slice(last, m.index), start: last, end: m.index });
    }
    segs.push({ kind: 'word', text: m[0], start: m.index, end: m.index + m[0].length });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segs.push({ kind: 'other', text: text.slice(last), start: last, end: text.length });
  }
  return segs;
}

/** 把各种弯引号归一成直引号，否则 you’re / can’t 这类词查不到词典。 */
function normalizeApostrophes(s) {
  return s.replace(/[\u2018\u2019\u02BC\u00B4`]/g, "'");
}

/**
 * 常见缩写 → 原形。
 *
 * 不做这一步的话，don't / can't / you're 在 ECDICT 里查不到，
 * 会整批被判成 L6「难」—— 把一个初学者百分百认识的词标红，
 * 会直接摧毁用户对难度标注的信任。
 */
const CONTRACTIONS = {
  "don't": 'do', "doesn't": 'do', "didn't": 'do',
  "can't": 'can', cannot: 'can', "couldn't": 'could',
  "won't": 'will', "wouldn't": 'would', "shan't": 'shall', "shouldn't": 'should',
  "mustn't": 'must', "needn't": 'need',
  "isn't": 'be', "aren't": 'be', "wasn't": 'be', "weren't": 'be', "ain't": 'be',
  "hasn't": 'have', "haven't": 'have', "hadn't": 'have',
  "i'm": 'be', "i've": 'have', "i'll": 'will', "i'd": 'would',
  "you're": 'you', "you've": 'have', "you'll": 'will', "you'd": 'would',
  "we're": 'we', "we've": 'have', "we'll": 'will', "we'd": 'would',
  "they're": 'they', "they've": 'have', "they'll": 'will', "they'd": 'would',
  "he's": 'he', "he'll": 'he', "he'd": 'he',
  "she's": 'she', "she'll": 'she', "she'd": 'she',
  "it's": 'it', "it'll": 'it',
  "that's": 'that', "there's": 'there', "what's": 'what', "who's": 'who',
  "here's": 'here', "let's": 'let', "where's": 'where',
};

/** 去掉所有格后缀，得到可查词的骨架。 */
function stripInflection(surface) {
  return surface.replace(/[’']s$/i, '').replace(/[’']$/, '');
}

/**
 * 把一个词形还原为词典原形。
 * 依次尝试：缩写还原 → 变形表 → 连字符分词还原 → 小写自身。
 *
 * @param {string} surface 文本中的原样词形
 * @param {(form:string)=>string|null} lookupLemma
 * @returns {string} 小写原形
 */
export function lemmatize(surface, lookupLemma) {
  const normalized = normalizeApostrophes(surface);
  const lower = stripInflection(normalized).toLowerCase();

  const expanded = CONTRACTIONS[lower];
  if (expanded) return lookupLemma(expanded) || expanded;

  const hit = lookupLemma(lower);
  if (hit) return hit;

  // 连字符复合词：分别还原后拼回（well-known → well-known）
  if (lower.includes('-')) {
    const parts = lower.split('-').map((p) => lookupLemma(p) || p);
    return parts.join('-');
  }
  return lower;
}

/**
 * 未收录词的难度推断。
 *
 * 连字符复合词（year-old / multi-photon / anti-concentration）在词典里
 * 往往整词没有条目，但每个组成部分都有。整词直接当「难」是错的：
 * year-old 由两个 L1 组成，实际很好读；multi-photon 的难点在 photon(L5)。
 * 所以取各组成部分里最难的那一档。
 *
 * @param {string} lemma
 * @param {{lookupWord:(w:string)=>any}} dict
 */
export function compoundLevel(lemma, dict) {
  if (!lemma.includes('-')) return 6;
  const levels = lemma
    .split('-')
    .filter((p) => p.length > 1)
    .map((p) => dict.lookupWord(p)?.level)
    .filter((v) => typeof v === 'number' && v > 0);
  return levels.length > 0 ? Math.max(...levels) : 6;
}

/**
 * 分析整段文本，返回片段 + 每个词的标注。
 *
 * @param {string} text
 * @param {{
 *   lookupWord: (word:string)=>({level:number,phonetic?:string,translation?:string,definition?:string,pos?:string,tags?:string}|null),
 *   lookupLemma: (form:string)=>string|null,
 * }} dict
 */
export function analyzeText(text, dict) {
  const segs = splitSegments(text);

  // 第一遍：统计每个词的形态信息
  /** @type {Map<string, {surfaces:Set<string>, capitalizedMid:boolean, count:number}>} */
  const stats = new Map();

  let prevSignificant = '';
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg.kind !== 'word') continue;
    if (!isWordToken(seg.text)) continue;

    const lemma = lemmatize(seg.text, dict.lookupLemma);
    let st = stats.get(lemma);
    if (!st) {
      st = { surfaces: new Set(), capitalizedMid: false, count: 0 };
      stats.set(lemma, st);
    }
    st.surfaces.add(seg.text);
    st.count += 1;

    // 句中大写 → 疑似专有名词。句首大写不算。
    const isSentenceStart = prevSignificant === '' || /[.!?]["')\]]?$/.test(prevSignificant);
    const startsUpper = /^[A-Z]/.test(seg.text);
    if (startsUpper && !isSentenceStart && !/^[A-Z]{2,}$/.test(seg.text)) {
      st.capitalizedMid = true;
    }
    prevSignificant = seg.text;
  }

  // 第二遍：为每个词条确定最终等级
  /** @type {Map<string, {word:string, level:number, dict:any, acronym:boolean, capitalizedMid:boolean, count:number}>} */
  const vocab = new Map();

  for (const [lemma, st] of stats) {
    const rec = dict.lookupWord(lemma);
    const baseLevel = rec ? rec.level : compoundLevel(lemma, dict);
    const acronym = [...st.surfaces].some(isAcronym);

    let level = baseLevel;
    // 专有名词与缩写不计入文本难度，独立成 level 0
    if (acronym) level = 0;
    else if (st.capitalizedMid && baseLevel >= 5) level = 0;

    vocab.set(lemma, {
      word: lemma,
      level,
      dict: rec,
      acronym,
      capitalizedMid: st.capitalizedMid,
      count: st.count,
    });
  }

  // 第三遍：把标注贴回片段
  const words = segs.map((seg) => {
    if (seg.kind !== 'word') return { ...seg };
    const lemma = lemmatize(seg.text, dict.lookupLemma);
    const v = vocab.get(lemma);
    return { ...seg, word: lemma, level: v ? v.level : 6 };
  });

  return { segments: words, vocab };
}

/**
 * 计算文本的难度画像。
 * @param {Map<string, {word:string, level:number, count:number}>} vocab
 */
export function textProfile(vocab) {
  /** @type {number[]} */
  const dist = [0, 0, 0, 0, 0, 0, 0];
  let totalTokens = 0;
  let contentTokens = 0;
  let sumLevel = 0;

  for (const v of vocab.values()) {
    dist[v.level] += v.count;
    totalTokens += v.count;
    if (v.level > 0) {
      contentTokens += v.count;
      sumLevel += v.level * v.count;
    }
  }

  return {
    dist,
    totalTokens,
    contentTokens,
    avgLevel: contentTokens ? sumLevel / contentTokens : 0,
    distinct: vocab.size,
    /** 给定用户已掌握到级别 k，返回超出 k 的 token 占比与去重词数 */
    unknownAt(k) {
      let tokens = 0;
      let distinct = 0;
      for (const v of vocab.values()) {
        if (v.level > k && v.level > 0) {
          tokens += v.count;
          distinct += 1;
        }
      }
      return { rate: contentTokens ? tokens / contentTokens : 0, tokens, distinct };
    },
  };
}

/**
 * 从纯文本中切出句子，并保留每句在原文中的字符区间。
 *
 * 区间是必需的：入库时要靠它把「句子」和「词」准确关联起来，
 * 否则会把整篇文章的词都挂到每一句上。
 *
 * @param {string} text
 * @returns {{text:string, start:number, end:number}[]}
 */
export function splitSentenceSpans(text) {
  /** @type {{text:string, start:number, end:number}[]} */
  const spans = [];
  // 段落换行也作为句子边界，避免跨段拼接
  const re = /[^.!?\n]+[.!?]+["')\]\u201d]*|[^.!?\n]+$/g;

  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index + lead;
    spans.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return spans;
}

/**
 * 从纯文本中切出句子（只要文本）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return splitSentenceSpans(text).map((s) => s.text);
}

/**
 * 把词片段按字符区间分配给句子。
 *
 * @param {{kind:'word'|'other', text:string, start:number, end:number, word?:string}[]} segments
 * @param {{text:string, start:number, end:number}[]} spans
 * @returns {Set<string>[]} 与 spans 等长，每项是该句包含的词的集合
 */
export function wordsPerSentence(segments, spans) {
  const out = spans.map(() => new Set());
  const ws = segments.filter((s) => s.kind === 'word' && s.word);
  let cursor = 0;

  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    while (cursor < ws.length && ws[cursor].end <= span.start) cursor += 1;
    for (let j = cursor; j < ws.length && ws[j].start < span.end; j += 1) {
      out[i].add(ws[j].word);
    }
  }
  return out;
}
