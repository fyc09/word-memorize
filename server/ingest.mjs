/**
 * 语料入库：抓取 → 提取正文 → 分词定级 → 落库。
 *
 * 「实时新闻」就是通过这个模块实现的：选文时如果池子不够，
 * 就地拉最新 RSS 并入库，用户拿到的永远是最新的文章。
 */

import { analyzeText, splitSentenceSpans, textProfile } from './tokenize.mjs';
import { bodyOf, listCandidates, pool } from './fetch.mjs';
import { dict, insertText, knownUrls } from './db.mjs';
import { normalizeSourceText } from './extract.mjs';
import { englishStats } from './lang.mjs';

/** 少于这个词数的文本不作为阅读材料。 */
const MIN_WORDS = 110;
/** 超过这个词数则截断（extract.mjs 里已处理，这里再兜一层）。 */
const MAX_WORDS = 1600;

/**
 * 处理一个 feed 条目：取正文、分析、入库。
 *
 * @param {import('./feeds.mjs').Feed} feed
 * @param {{title:string, link:string, published:string, summary:string, content:string}} item
 * @returns {Promise<{textId:number, words:number, title:string}|null>}
 */
export async function ingestCandidate(feed, item) {
  const body = await bodyOf(feed, item);
  if (!body || !body.text) return null;

  // 必须在分词前清理：字符偏移量（句子挖空、词高亮）都基于清理后的文本
  const text = normalizeSourceText(body.text);
  if (!text) return null;

  const analysis = analyzeText(text, dict);
  const profile = textProfile(analysis.vocab);

  if (profile.contentTokens < MIN_WORDS || profile.contentTokens > MAX_WORDS) return null;

  // 语料源会混进非英语文章（NPR 出现过西语报道）。
  // 不挡掉的话，每个词都查不到词典，整篇会被误判成「难」。
  const lang = englishStats(analysis.segments);
  if (!lang.ok) return null;

  const spans = splitSentenceSpans(text);
  if (spans.length < 3) return null;

  const textId = insertText({
    source: feed.name,
    category: feed.category,
    title: body.title || item.title || null,
    url: item.link,
    published: item.published || null,
    body: text,
    analysis,
    profile,
    spans,
  });

  return { textId, words: profile.contentTokens, title: body.title || item.title };
}

/** 单个源单次最多贡献几篇，避免被刷屏。 */
const DEFAULT_MAX_PER_FEED = 3;

/**
 * 确保库里有足够的未读文章可用。
 *
 * @param {{categories?:string[], want?:number, perFeed?:number, maxPerFeed?:number, concurrency?:number}} opts
 * @returns {Promise<{scanned:number, ingested:number, failed:number}>}
 */
export async function ensurePool(opts = {}) {
  const want = opts.want ?? 12;
  const perFeed = opts.perFeed ?? 8;
  const concurrency = opts.concurrency ?? 6;
  const maxPerFeed = opts.maxPerFeed ?? DEFAULT_MAX_PER_FEED;

  const candidates = await listCandidates({
    categories: opts.categories,
    perFeed,
    knownUrls: knownUrls(),
  });

  if (candidates.length === 0) {
    return { scanned: 0, ingested: 0, failed: 0 };
  }

  // 排序成「题材轮转」。
  //
  // FEEDS 里新闻排在最前，若直接按源顺序取，want=10 时会被新闻全部吃满，
  // 科普与学术一条都进不来（用户选了题材却拿不到对应文章）。
  // 所以先按题材分组，再逐轮各取一条，保证任何 want 下三类都有机会出现。
  /** @type {Map<string, any[]>} */
  const byCategory = new Map();
  for (const c of candidates) {
    const list = byCategory.get(c.feed.category) || [];
    list.push(c);
    byCategory.set(c.feed.category, list);
  }

  const perCategory = [];
  for (const list of byCategory.values()) {
    // 题材内部再按源轮转，避免被单个源刷屏
    const byFeed = new Map();
    for (const c of list) {
      const q = byFeed.get(c.feed.id) || [];
      if (q.length < maxPerFeed) q.push(c);
      byFeed.set(c.feed.id, q);
    }
    const queues = [...byFeed.values()];
    const merged = [];
    for (let round = 0; merged.length < list.length; round += 1) {
      let added = false;
      for (const q of queues) {
        if (round < q.length) {
          merged.push(q[round]);
          added = true;
        }
      }
      if (!added) break;
    }
    perCategory.push(merged);
  }

  const ordered = [];
  const depth = Math.max(0, ...perCategory.map((l) => l.length));
  for (let round = 0; round < depth; round += 1) {
    for (const list of perCategory) {
      if (round < list.length) ordered.push(list[round]);
    }
  }

  // 分批抓取，凑够 want 篇就停 —— 不为了「多抓」而白白消耗网络与时间。
  let ingested = 0;
  let failed = 0;
  for (let i = 0; i < ordered.length; i += concurrency) {
    const batch = ordered.slice(i, i + concurrency);
    const results = await pool(batch, concurrency, async (c) => ingestCandidate(c.feed, c.item));
    const ok = results.filter(Boolean).length;
    ingested += ok;
    failed += batch.length - ok;
    if (ingested >= want) break;
  }

  return { scanned: candidates.length, ingested, failed };
}

export { MIN_WORDS, MAX_WORDS };
