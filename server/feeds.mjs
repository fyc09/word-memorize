/**
 * 语料源注册表。
 *
 * 覆盖用户指定的三类题材：新闻 / 科普 / 学术。
 * 每个源都带一个 levelHint —— 该源的典型语言难度，用于给选文排序打底，
 * 真实难度仍以入库时算出的词频分布为准。
 */

/** @typedef {'news'|'science'|'academic'} Category */

export const CATEGORIES = {
  news: { key: 'news', name: '新闻', desc: '时事报道，语言平实、时效性强' },
  science: { key: 'science', name: '科普', desc: '科学报道，术语密度中等' },
  academic: { key: 'academic', name: '学术', desc: '论文摘要与研究报道，术语密集' },
};

/**
 * @typedef {Object} Feed
 * @property {string} id
 * @property {string} name
 * @property {Category} category
 * @property {string} url
 * @property {number} levelHint
 * @property {string} [note]
 * @property {boolean} [fullTextInFeed]  feed 自带全文，无需抓文章页
 */

/** @type {Feed[]} */
export const FEEDS = [
  // ---------------------------------------------------------------- 新闻
  {
    id: 'bbc-world',
    name: 'BBC News',
    category: 'news',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    levelHint: 3,
  },
  {
    id: 'bbc-science',
    name: 'BBC Science',
    category: 'news',
    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    levelHint: 3,
  },
  {
    id: 'npr-news',
    name: 'NPR',
    category: 'news',
    url: 'https://feeds.npr.org/1001/rss.xml',
    levelHint: 3,
  },
  {
    id: 'guardian-world',
    name: 'The Guardian',
    category: 'news',
    url: 'https://www.theguardian.com/world/rss',
    levelHint: 4,
  },
  {
    id: 'guardian-science',
    name: 'The Guardian · Science',
    category: 'news',
    url: 'https://www.theguardian.com/science/rss',
    levelHint: 4,
  },

  // ---------------------------------------------------------------- 科普
  {
    id: 'quanta',
    name: 'Quanta Magazine',
    category: 'science',
    url: 'https://www.quantamagazine.org/feed/',
    levelHint: 5,
    note: '数学/物理/生物深度报道，行文优美',
  },
  {
    id: 'newscientist',
    name: 'New Scientist',
    category: 'science',
    url: 'https://www.newscientist.com/feed/home/',
    levelHint: 4,
  },
  {
    id: 'sciencedaily',
    name: 'ScienceDaily',
    category: 'science',
    url: 'https://www.sciencedaily.com/rss/all.xml',
    levelHint: 4,
    note: '短篇研究简讯，篇幅接近理想长度',
  },
  {
    id: 'nasa',
    name: 'NASA',
    category: 'science',
    url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',
    levelHint: 4,
    fullTextInFeed: true,
  },
  {
    id: 'physorg',
    name: 'Phys.org',
    category: 'science',
    url: 'https://phys.org/rss-feed/',
    levelHint: 5,
    note: '页面为 JS 渲染，正文常常提取失败',
  },

  // ---------------------------------------------------------------- 学术
  {
    id: 'arxiv-cs-cl',
    name: 'arXiv · 计算语言学',
    category: 'academic',
    url: 'https://export.arxiv.org/api/query?search_query=cat:cs.CL&start=0&max_results=25&sortBy=submittedDate&sortOrder=descending',
    levelHint: 6,
    note: '纯文本摘要，无 HTML 噪声',
  },
  {
    id: 'arxiv-cs-lg',
    name: 'arXiv · 机器学习',
    category: 'academic',
    url: 'https://export.arxiv.org/api/query?search_query=cat:cs.LG&start=0&max_results=25&sortBy=submittedDate&sortOrder=descending',
    levelHint: 6,
  },
  {
    id: 'arxiv-phys',
    name: 'arXiv · 物理',
    category: 'academic',
    url: 'https://export.arxiv.org/api/query?search_query=cat:cond-mat.stat-mech&start=0&max_results=20&sortBy=submittedDate&sortOrder=descending',
    levelHint: 6,
  },
  {
    id: 'plos-one',
    name: 'PLOS ONE',
    category: 'academic',
    url: 'https://journals.plos.org/plosone/feed/atom',
    levelHint: 6,
  },
];

/** 按 id 取源。 */
export function feedById(id) {
  return FEEDS.find((f) => f.id === id) || null;
}

/** 取某个题材下的源；不传题材则返回全部。 */
export function feedsFor(category) {
  return category ? FEEDS.filter((f) => f.category === category) : FEEDS;
}
