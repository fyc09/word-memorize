/**
 * 语种判定。
 *
 * 语料源里会混进非英语文章 —— NPR 的 feed 里就出现过西语报道
 * （"En esta ciudad de Pensilvania, los dos partidos..."）。
 * 这类文本的每个词都查不到词典，会被整体误判成「难」，必须先挡掉。
 *
 * 判据用英语功能词（the / of / and …）：它们在真实英语里占据 20%–35% 的 token，
 * 在其它语言里几乎不出现，区分度非常高。
 */

const EN_FUNCTION_WORDS = new Set([
  'the', 'of', 'and', 'to', 'in', 'a', 'is', 'that', 'for', 'it', 'with', 'as',
  'was', 'on', 'be', 'at', 'by', 'this', 'have', 'from', 'or', 'an', 'are',
  'but', 'not', 'they', 'his', 'her', 'which', 'will', 'would', 'there',
  'their', 'what', 'about', 'when', 'has', 'been', 'can', 'more', 'no', 'if',
  'out', 'so', 'said', 'up', 'its', 'who', 'now', 'we', 'you', 'he', 'she',
  'were', 'them', 'than', 'then', 'into', 'only', 'also', 'some', 'such',
]);

/** 至少命中这么多个不同的功能词。 */
const MIN_DISTINCT = 8;
/** 功能词 token 占比下限。真实英语通常 0.20–0.35。 */
const MIN_RATIO = 0.12;
/** 样本太短时判定不可靠，直接放行交给长度校验去挡。 */
const MIN_SAMPLE = 40;

/**
 * 判断一段已分词的文本是否为英语。
 * @param {{kind:'word'|'other', text:string}[]} segments
 * @returns {{ok:boolean, ratio:number, distinct:number}}
 */
export function englishStats(segments) {
  const words = segments.filter((s) => s.kind === 'word');
  if (words.length < MIN_SAMPLE) {
    return { ok: true, ratio: 1, distinct: MIN_DISTINCT };
  }

  let hits = 0;
  const distinct = new Set();
  for (const w of words) {
    const l = w.text.toLowerCase();
    if (EN_FUNCTION_WORDS.has(l)) {
      hits += 1;
      distinct.add(l);
    }
  }

  const ratio = hits / words.length;
  return {
    ok: distinct.size >= MIN_DISTINCT && ratio >= MIN_RATIO,
    ratio,
    distinct: distinct.size,
  };
}

/** 便捷布尔封装。 */
export function looksEnglish(segments) {
  return englishStats(segments).ok;
}

export { MIN_DISTINCT, MIN_RATIO };
