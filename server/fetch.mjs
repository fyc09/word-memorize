/**
 * 语料抓取：RSS/Atom 解析 → 正文提取 → 入库。
 *
 * 设计要点：
 *   - 新闻要「实时」。所以抓取是按需触发的：选文时若池子不够新/不够多，
 *     就现场拉 RSS 并抓正文，而不是只依赖预置语料。
 *   - 已入库的 URL 不重复抓取，所以重复触发是廉价的（只解析 RSS）。
 *   - feed 摘要有时本身就是合格的阅读材料（arXiv 摘要 150–250 词），
 *     够长就直接用，不必回源抓页面。
 */

import * as cheerio from 'cheerio';
import { extractArticle, htmlFragmentToText } from './extract.mjs';
import { FEEDS, feedsFor } from './feeds.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 摘要达到这个词数就足以独立成篇（典型场景：arXiv 摘要）。 */
const SUMMARY_USABLE_WORDS = 100;

/**
 * 带超时与 UA 的文本抓取。
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
export async function fetchText(url, timeoutMs = 20000) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * 解析 RSS 2.0 或 Atom feed。
 * @param {string} xml
 * @returns {{title:string, link:string, published:string, summary:string, content:string}[]}
 */
export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  /** @type {{title:string, link:string, published:string, summary:string, content:string}[]} */
  const items = [];

  const textOf = (el) => $(el).text().replace(/\s+/g, ' ').trim();

  // ---- RSS 2.0
  $('item').each((_, el) => {
    const $el = $(el);
    const link = textOf($el.find('link').first()) || textOf($el.find('guid').first());
    items.push({
      title: textOf($el.find('title').first()),
      link,
      published: textOf($el.find('pubDate').first()) || textOf($el.find('date').first()),
      summary: textOf($el.find('description').first()),
      content:
        textOf($el.find('content\\:encoded').first()) ||
        textOf($el.find('encoded').first()),
    });
  });

  // ---- Atom
  if (items.length === 0) {
    $('entry').each((_, el) => {
      const $el = $(el);
      let link = $el.find('link[rel="alternate"]').attr('href') || '';
      if (!link) link = $el.find('link').first().attr('href') || '';
      if (!link) link = textOf($el.find('id').first());
      items.push({
        title: textOf($el.find('title').first()),
        link,
        published: textOf($el.find('published').first()) || textOf($el.find('updated').first()),
        summary: textOf($el.find('summary').first()),
        content: textOf($el.find('content').first()),
      });
    });
  }

  return items.filter((it) => it.link && /^https?:/.test(it.link));
}

/**
 * 取得一篇 feed 条目的可读正文。
 *
 * 顺序：
 *   1. feed 自带的全文（content:encoded / content）
 *   2. 足够长的摘要（arXiv 这类）
 *   3. 抓文章页做正文提取
 *
 * @param {import('./feeds.mjs').Feed} feed
 * @param {{title:string, link:string, published:string, summary:string, content:string}} item
 * @returns {Promise<{text:string, title:string}|null>}
 */
export async function bodyOf(feed, item) {
  const words = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

  const inline = item.content || '';
  if (words(inline) >= SUMMARY_USABLE_WORDS) {
    const cleaned = inline.replace(/\s+/g, ' ').trim();
    // content:encoded 里可能裹着 HTML
    const text = /<[a-z][\s\S]*>/i.test(cleaned) ? cleanInline(cleaned) : cleaned;
    if (words(text) >= 100) return { text, title: item.title };
  }

  if (words(item.summary) >= SUMMARY_USABLE_WORDS) {
    return { text: item.summary, title: item.title };
  }

  const html = await fetchText(item.link, 25000);
  if (!html) return null;
  const extracted = extractArticle(html);
  if (!extracted) return null;
  return { text: extracted.text, title: extracted.title || item.title };
}

/** 把 feed 内嵌的 HTML 片段转成纯文本。 */
function cleanInline(html) {
  // 必须用 htmlFragmentToText 而不是 cheerio 的 .text()：
  // NASA 的 content:encoded 里 <b>Bright</b>apods 这种写法一旦直接取 text，
  // 会粘成 Brightapods 这种查不到词典的假单词。
  return htmlFragmentToText(html).replace(/\s+/g, ' ').trim();
}

/**
 * 简单的并发池。
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;

  const runNext = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  };

  const runners = [];
  const n = Math.min(limit, items.length);
  for (let k = 0; k < n; k += 1) runners.push(runNext());

  await Promise.all(runners);
  return results;
}

/**
 * 拉取一批 feed，返回尚未入库的候选条目。
 *
 * @param {{categories?:string[], perFeed?:number, knownUrls?:Set<string>}} opts
 * @returns {Promise<{feed:import('./feeds.mjs').Feed, item:any}[]>}
 */
export async function listCandidates(opts = {}) {
  const perFeed = opts.perFeed ?? 8;
  const known = opts.knownUrls ?? new Set();
  const feeds = feedsFor(opts.categories?.length === 1 ? opts.categories[0] : undefined).filter(
    (f) => !opts.categories?.length || opts.categories.includes(f.category),
  );

  const perFeedResults = await pool(feeds, 6, async (feed) => {
    const xml = await fetchText(feed.url, 20000);
    if (!xml) return [];
    return parseFeed(xml)
      .slice(0, perFeed)
      .filter((it) => !known.has(it.link))
      .map((item) => ({ feed, item }));
  });

  return perFeedResults.filter(Boolean).flat();
}

/** 全部源（供前端展示）。 */
export { FEEDS };
