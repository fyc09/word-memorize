/**
 * 文章正文提取（轻量 readability）。
 *
 * 我们需要的是一段 **250–600 词的真实文章正文**，
 * 而 RSS 大多只给 100–600 字符的摘要，所以必须回到文章页提取正文。
 *
 * 策略：
 *   1. 优先使用 feed 里自带的 content:encoded（NASA / New Scientist 会给全文）
 *   2. 否则抓文章页，剔除噪声标签，对候选容器按「段落的有效文字量」打分，取最优
 *   3. 只保留长度达标的段落，避免导航 / 页脚 / 版权声明混入
 */

import * as cheerio from 'cheerio';

const NOISE = [
  'script', 'style', 'noscript', 'iframe', 'form', 'svg', 'button',
  'nav', 'header', 'footer', 'aside', 'figure', 'figcaption',
  'template', 'video', 'audio', 'canvas', 'select', 'option',
];

/** 明显是噪声的容器 class / id 关键词。 */
const NOISE_HINT =
  /(nav|menu|footer|header|sidebar|comment|related|promo|newsletter|subscribe|share|social|advert|ads?[-_]|cookie|banner|breadcrumb|pagination|tag[-_]?list|author[-_]?box|most[-_]?read|recommend)/i;

/** 正文容器候选的正向关键词。 */
const CONTENT_HINT =
  /(article|story|content|body|post|entry|text|main|prose|transcript)/i;

/**
 * 清理源文本里的 LaTeX 残留。
 *
 * arXiv 摘要把 LaTeX 原样带了出来，分词后 \textbf / \propto / \infty /
 * \varepsilon 会变成 “textbf”“propto” 这类假单词，在读者眼里就是
 * 一堆无法解读的红色生僻词。这些是抓取噪声，不是词汇，必须在入库前去掉。
 *
 * 注意：必须在分词**之前**对整个正文做一次，这样后续的字符偏移量
 * （句子挖空、词高亮都依赖它）才是基于清理后的文本计算的。
 *
 * @param {string} text
 */
export function normalizeSourceText(text) {
  return text
    // \textbf{x} / \emph{x} → 保留括号里的内容
    .replace(/\\(?:textbf|textit|emph|mathrm|mathbf|text|mbox|hbox)\s*\{([^{}]*)\}/g, '$1')
    // 其它 \command{...} → 整体丢弃
    .replace(/\\[a-zA-Z]+\*?\s*(?:\{[^{}]*\})?/g, ' ')
    // 剩下的花括号、美元符、反斜杠是公式符号，不是词
    .replace(/[${}\\]/g, ' ')
    // 裸 URL 与泄漏的链接属性都不是词汇。
    // 正常情况下标签已经被剥掉了，这里是安全网：
    // 个别站的 liveblog 会把 <a href="…">Continue reading</a> 整段带进正文，
    // 于是 hrefhttpswwwtheguardiancom…continue 变成一个巨大的红色假单词。
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.[\w.-]+/gi, ' ')
    .replace(/\bhref\S*/gi, ' ')
    // 归一空白
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 把一段 HTML 片段转成纯文本，**在标签边界处插入空格**。
 *
 * 这是关键：cheerio 的 .text() 会把相邻内联标签的字直接粘起来。
 * `The <a>Guardian</a> reported` 变成 "TheGuardian reported"，
 * <b>Bright</b>apods 变成 "Brightapods"。这些粘连词在词典里查不到，
 * 会被当作生僻词标成红色，用户看到的就是一批无法解读的假单词。
 *
 * 语料源里有两条路径会走到这里：文章页正文提取，以及 feed 自带的
 * content:encoded（NASA 的 feed 会给全文）。两处都必须用它。
 *
 * @param {string|undefined|null} html
 * @returns {string}
 */
export function htmlFragmentToText(html) {
  if (!html) return '';

  // 第一趟：剥掉真实标签。
  const stripped = String(html).replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

  // 解码 HTML 实体（&amp; / &lt; / &nbsp; / &#39; …）
  const decoded = cheerio.load(`<x-s>${stripped}</x-s>`)('x-s').text();

  // 第二趟：有些站点的正文里存的是「转义过的 HTML」（&lt;p&gt; / &lt;a href="…"&gt;）。
  // 它们在解码之后才会变成真标签和 URL 属性值，第一趟正好错过。
  // 不补这一趟的话，“island&lt;/p&gt;&lt;p&gt;this” 会被拆成 island / pp / this，
  // 而 <a href="https://…"> 会整条 URL 变成 hrefhttpswww… 这样一个假单词。
  return decoded.replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/\s+/g, ' ');
}

/**
 * 清洗一段 HTML 片段，返回纯文本。
 * @param {string} html
 */
export function htmlToText(html) {
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  $('#__root').find(NOISE.join(',')).remove();
  return ($('#__root').text() || '').replace(/\s+/g, ' ').trim();
}
/**
 * 从文章页 HTML 中提取正文。
 * @param {string} html
 * @param {{minWords?:number, maxWords?:number}} [opts]
 * @returns {{ text: string, title: string|null, paragraphs: number }|null}
 */
export function extractArticle(html, opts = {}) {
  const minWords = opts.minWords ?? 120;
  const maxWords = opts.maxWords ?? 1600;

  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    $('title').first().text().trim() ||
    null;

  $(NOISE.join(',')).remove();

  // 收集所有候选容器：常见语义标签 + 带正向 class/id 关键词的元素
  /** @type {any[]} */
  let candidates = $('article, main, [role="main"], [itemprop="articleBody"]').toArray();

  $('div, section').each((_, el) => {
    const $el = $(el);
    const sig = `${$el.attr('class') || ''} ${$el.attr('id') || ''}`;
    if (NOISE_HINT.test(sig)) return;
    if (CONTENT_HINT.test(sig)) candidates.push(el);
  });

  if (candidates.length === 0) candidates = $('body').toArray();

  /**
   * 给容器打分：统计其中「够长的段落」的总词数。
   * 长段落越多，越可能是正文。
   * @param {any} el
   */
  const scoreOf = (el) => {
    const $el = $(el);
    let words = 0;
    let paras = 0;
    $el.find('p, h2, h3, li, blockquote').each((_, p) => {
      const t = $(p).text().replace(/\s+/g, ' ').trim();
      const w = t.split(/\s+/).filter(Boolean).length;
      if (w >= 8) {
        words += w;
        paras += 1;
      }
    });
    // 段落数太少时降低权重，避免选中只有一句话的摘要块
    return paras >= 3 ? words * (1 + Math.min(paras, 40) / 40) : words * 0.4;
  };

  let best = null;
  let bestScore = -1;
  for (const el of candidates) {
    const s = scoreOf(el);
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }
  if (!best) return null;

  const $best = $(best);
  /** @type {string[]} */
  const paragraphs = [];

  $best.find('p, h2, h3, blockquote, li').each((_, p) => {
    const t = htmlFragmentToText($(p).html()).replace(/\s+/g, ' ').trim();
    const w = t.split(/\s+/).filter(Boolean).length;
    if (w >= 8) paragraphs.push(t);
  });

  // 容器本身可能就是一段纯文本（例如某些站点的 <article> 里没有 <p>）
  if (paragraphs.length < 3) {
    const raw = htmlFragmentToText($best.html()).replace(/\s+/g, ' ').trim();
    if (raw.split(/\s+/).length >= minWords) paragraphs.push(raw);
  }

  if (paragraphs.length === 0) return null;

  let text = paragraphs.join('\n\n');
  let words = text.split(/\s+/).filter(Boolean).length;

  if (words > maxWords) {
    // 超长时按段落截断，尽量保留前半部分的完整论证
    const kept = [];
    let count = 0;
    for (const p of paragraphs) {
      const w = p.split(/\s+/).filter(Boolean).length;
      if (count + w > maxWords) break;
      kept.push(p);
      count += w;
    }
    text = kept.join('\n\n');
    words = count;
  }

  if (words < minWords) return null;

  return { text, title: title ? title.replace(/\s+/g, ' ').trim() : null, paragraphs: paragraphs.length };
}
