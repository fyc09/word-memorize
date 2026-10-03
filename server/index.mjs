/**
 * HTTP API 服务。
 *
 * 用 node:http 手写路由，不引 web 框架 —— 接口只有十几个，
 * 少一层依赖就少一处升级/兼容风险。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, db, lookupWord, getSetting, setSetting, logActivity } from './db.mjs';
import { LEVELS } from './level.mjs';
import { compoundLevel } from './tokenize.mjs';
import { GRADES, schedule, stageOf, STAGES } from './srs.mjs';
import {
  annotateSentence,
  attachAnalysis,
  exampleSentences,
  pickLearnText,
  planReview,
} from './select.mjs';
import {
  currentSession,
  finishSession,
  markedWordsOf,
  sessionPayload,
  startSession,
  textLibrary,
  textLibraryCount,
} from './session.mjs';
import { latestJob, runningJob, reapStaleJobs, startFetchJob } from './jobs.mjs';
import { boilerplateStart } from './extract.mjs';
import { CATEGORIES, FEEDS } from './feeds.mjs';

// 上一次进程被杀掉时留下的 'running' 任务会永远转圈，
// 启动时先收尸，否则抓取按钮会一直不可用。
const reaped = reapStaleJobs();
if (reaped > 0) console.log(`清理了 ${reaped} 条中断的后台任务`);

const PORT = Number(process.env.PORT) || 3001;
const DIST_DIR = path.join(ROOT, 'dist');

// ---------------------------------------------------------------- 工具

/** @param {http.ServerResponse} res */
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/**
 * 读取并解析请求体。
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

const EXCHANGE_LABELS = {
  0: '原形',
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  3: '第三人称单数',
  s: '复数',
  r: '比较级',
  t: '最高级',
};

/** 把 ECDICT 的 exchange 字段转成可读的变形列表。 */
function readableExchange(exchange) {
  if (!exchange) return [];
  const out = [];
  for (const part of String(exchange).split('/')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const label = EXCHANGE_LABELS[key];
    if (!label || key === '1') continue;
    for (const form of part.slice(idx + 1).split(',')) {
      const f = form.trim();
      if (f) out.push({ label, form: f });
    }
  }
  return out;
}

/** 用户设定的当前水平（1–6）。 */
function currentLevel() {
  return Number(getSetting('level', '3')) || 3;
}

/** 用户选定的题材。空表示不限。 */
function currentCategories() {
  const raw = getSetting('categories', '');
  const list = String(raw).split(',').map((s) => s.trim()).filter((c) => CATEGORIES[c]);
  return list;
}

/**
 * 是否用颜色标注难度。默认开。
 *
 * 存在设置里而不是前端 state —— 它是全局开关，
 * 刷新页面、下次打开都不应该被重置。
 */
function currentShowLevels() {
  return getSetting('showLevels', '1') !== '0';
}

// ---------------------------------------------------------------- 数据操作

/**
 * 标记一个词时的「出处」。
 *
 * 客户端给得出上下文就直接用（点例句里的词、复习时评的词）；
 * 给不出就看当前阅读会话 —— 用户正在读哪一篇，多半就是他在哪儿遇到这个词。
 * sentenceId 没给就在这篇里现找一句包含它的，
 * 这样记录里能回看原句，而不用只给一个文章标题。
 */
function resolveOrigin(word, textId, sentenceId) {
  const tid = textId ?? currentSession()?.text_id ?? null;
  if (!tid) return { textId: null, sentenceId: null };
  const sid =
    sentenceId ??
    db
      .prepare(`
        SELECT s.id FROM sentence_words sw
        JOIN sentences s ON s.id = sw.sentence_id
        WHERE sw.word = ? AND s.text_id = ?
        ORDER BY LENGTH(s.text) ASC
        LIMIT 1
      `)
      .get(word, tid)?.id ??
    null;
  return { textId: tid, sentenceId: sid };
}

/** 标记一个词为生词。 */
function markWord(word, textId, sentenceId) {
  const rec = lookupWord(word);
  const level = rec ? rec.level : 6;
  const now = new Date().toISOString();
  const origin = resolveOrigin(word, textId, sentenceId);

  const existing = db.prepare('SELECT word FROM vocab WHERE word = ?').get(word);
  if (!existing) {
    db.prepare(`
      INSERT INTO vocab (word, level, status, first_text_id, first_sentence_id, created_at, due_at)
      VALUES (?, ?, 'learning', ?, ?, ?, ?)
    `).run(word, level, origin.textId, origin.sentenceId, now, now);
  }

  logActivity('mark', {
    word,
    textId: origin.textId,
    detail: { sentenceId: origin.sentenceId },
  });

  return db.prepare('SELECT * FROM vocab WHERE word = ?').get(word);
}

/** 取消标记（误点）。 */
function unmarkWord(word) {
  // vocab 里已经复习过的词不删，只归档 —— 避免误点丢掉复习进度
  const row = db.prepare('SELECT reps FROM vocab WHERE word = ?').get(word);
  if (!row) return { removed: false };

  if (row.reps > 0) {
    db.prepare("UPDATE vocab SET status = 'archived' WHERE word = ?").run(word);
    logActivity('unmark', { word, detail: { archived: true } });
    return { removed: false, archived: true };
  }

  db.prepare('DELETE FROM vocab WHERE word = ?').run(word);
  logActivity('unmark', { word });
  return { removed: true };
}

/**
 * 词条详情：释义 + 变形 + 真实例句 + 当前学习状态。
 *
 * @param {string} word
 * @param {number} [excludeTextId]
 * @param {number} [levelHint] 该词**在这篇正文里**被标成了几级。
 *   卡片必须与用户刚才看到的颜色一致，所以有 hint 时以它为准：
 *   专有名词（L0）与连字符复合词（year-old）的等级都依赖上下文，
 *   光看词典条目算不出来。
 */
/**
 * 这批词里哪些在生词本里。
 * 口径与 markedWordsOf 一致（status != archived）。
 */
function markedAmong(words) {
  const uniq = [...new Set(words)];
  if (uniq.length === 0) return [];
  const holes = uniq.map(() => '?').join(',');
  return db
    .prepare(`SELECT word FROM vocab WHERE status != 'archived' AND word IN (${holes})`)
    .all(...uniq)
    .map((r) => r.word);
}

/**
 * 一条记录里那句原句的可交互版本。
 *
 * 不在记录列表里就带回来：一句分词的 JSON 约 2.6KB，25 条就是 65KB，
 * 而列表现在只有 1.4KB —— 词卡每次查词都要拉历史，不能这么涨。
 * 所以只在记录被展开时才按需要这一句。
 */
function sentenceDetail(sentenceId) {
  const row = db.prepare('SELECT text FROM sentences WHERE id = ?').get(sentenceId);
  if (!row) return { segments: [], markedWords: [] };
  const { segments, words } = annotateSentence(row.text);
  return { segments, markedWords: markedAmong(words) };
}

function wordDetail(word, excludeTextId, levelHint) {
  const rec = lookupWord(word);
  const card = db.prepare('SELECT * FROM vocab WHERE word = ?').get(word) || null;
  const history = db
    .prepare(`
      SELECT a.id, a.at, a.kind, a.word, a.text_id, a.detail,
             t.title, t.source, t.category, t.url,
             s.text AS sentence
      FROM activity a
      LEFT JOIN texts t ON t.id = a.text_id
      LEFT JOIN sentences s ON s.id = json_extract(a.detail, '$.sentenceId')
      WHERE a.word = ?
      ORDER BY a.at DESC, a.id DESC
      LIMIT 40
    `)
    .all(word)
    .map((r) => ({ ...r, detail: safeJson(r.detail) }));

  const hint = Number(levelHint);
  let level;
  if (Number.isInteger(hint) && hint >= 0 && hint <= 6) level = hint;
  else if (rec) level = rec.level;
  else level = compoundLevel(word, { lookupWord });

  const examples = exampleSentences(word, { excludeTextId, limit: 6 });

  /*
   * 例句里哪些词在生词本里。
   *
   * 由服务端给，而不是让调用方传一个「当前这篇标记了哪些词」的集合 ——
   * 例句来自别的文章，那个集合对例句几乎永远不命中（两边都是按文本过滤的）。
   * 交给服务端按全局口径标出后，词卡在正文旁边、在复习页里就自然是同一套渲染，
   * 不依赖调用方记得多传一个 prop。
   */
  const markedWords = markedAmong(
    examples.flatMap((ex) =>
      (ex.segments ?? [])
        .filter((s) => s.kind === 'word')
        .map((s) => s.word ?? s.text.toLowerCase()),
    ),
  );

  return {
    word,
    found: Boolean(rec),
    level,
    levelName: LEVELS[level].name,
    phonetic: rec?.phonetic || null,
    pos: rec?.pos || null,
    translation: rec?.translation || null,
    definition: rec?.definition || null,
    tags: rec?.tags ? String(rec.tags).split(/\s+/).filter(Boolean) : [],
    variants: readableExchange(rec?.exchange),
    examples,
    markedWords,
    card: card
      ? { ...card, stage: stageOf(card), stageName: STAGES[stageOf(card)].name }
      : null,
    history,
  };
}

/**
 * 把一行 SQL 结果变成词表的行。
 *
 * /api/words 和 /api/learn/finish 共用 —— 前者是整库词表，
 * 后者是「刚读完这篇里标记的词」，两处的列表要求长得一模一样，
 * 字段各造一份就会漂（原本 finish 只给 word/translation，
 * 所以摘要页只能自己画一行，和单词本完全不同）。
 */
function toWordRow(r) {
  const studied = r.reps !== null;
  const card = studied
    ? { ease: 2.5, interval_days: r.interval_days, reps: r.reps, lapses: r.lapses, verified: r.verified }
    : null;
  const stageKey = card ? stageOf(card) : 'none';
  return {
    word: r.word,
    level: r.level,
    phonetic: r.phonetic,
    pos: r.pos,
    translation: r.translation,
    tags: r.tags,
    reps: r.reps,
    lapses: r.lapses,
    due_at: r.due_at,
    verified: r.verified,
    interval_days: r.interval_days,
    studied,
    stage: stageKey,
    stageName: stageKey === 'none' ? '无数据' : (STAGES[stageKey]?.name ?? stageKey),
  };
}

/** 解析 JSON 列，脏数据不抛异常。 */
function safeJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 路由

/** @type {Record<string, (ctx:any)=>Promise<any>|any>} */
const routes = {
  'GET /api/state': () => {
    const now = new Date().toISOString();
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN due_at IS NULL OR due_at <= ? THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN verified = 0 THEN 1 ELSE 0 END) AS unverified,
        SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN interval_days >= 21 THEN 1 ELSE 0 END) AS mature,
        SUM(CASE WHEN reps > 0 THEN 1 ELSE 0 END) AS reviewed
      FROM vocab WHERE status != 'archived'
    `).get(now);

    // 复习统计改为查 append-only 流水（reviews 表已并入 activity）
    const reviews = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN json_extract(detail, '$.mode') = 'cloze' THEN 1 ELSE 0 END) AS cloze,
             SUM(CASE WHEN json_extract(detail, '$.mode') = 'reading' THEN 1 ELSE 0 END) AS reading,
             SUM(CASE WHEN json_extract(detail, '$.grade')
                       IN ('cloze_good', 'cloze_fuzzy', 'reading_good') THEN 1 ELSE 0 END) AS ok
      FROM activity WHERE kind = 'review'
    `).get();

    const texts = db.prepare('SELECT COUNT(*) AS c FROM texts').get().c;

    return {
      level: currentLevel(),
      categories: currentCategories(),
      showLevels: currentShowLevels(),
      levels: LEVELS,
      stages: STAGES,
      categoriesMeta: CATEGORIES,
      vocab: { ...counts, due: counts.due ?? 0 },
      reviews,
      corpus: {
        texts,
        readTexts: textLibraryCount('done'),
        reading: textLibraryCount('reading'),
        unread: textLibraryCount('unread'),
      },
      // 前端据此决定「抓取新文章」是否要置灰
      fetchJob: runningJob('fetch') ?? latestJob('fetch'),
    };
  },

  'POST /api/settings': async ({ body }) => {
    if (body.level !== undefined) {
      const lv = Number(body.level);
      if (!Number.isInteger(lv) || lv < 1 || lv > 6) throw new Error('level 必须是 1–6');
      setSetting('level', lv);
    }
    if (body.categories !== undefined) {
      const list = (Array.isArray(body.categories) ? body.categories : [])
        .filter((c) => CATEGORIES[c]);
      setSetting('categories', list.join(','));
    }
    if (body.showLevels !== undefined) {
      setSetting('showLevels', body.showLevels ? '1' : '0');
    }
    return {
      level: currentLevel(),
      categories: currentCategories(),
      showLevels: currentShowLevels(),
    };
  },

  /** 从文本库点开某一篇。会开一个新会话（已读完的可重读）。 */
  'POST /api/learn/open': ({ body }) => {
    const textId = Number(body.textId);
    if (!textId) throw new Error('缺少 textId');
    if (!db.prepare('SELECT id FROM texts WHERE id = ?').get(textId)) {
      throw new Error('文本不存在');
    }
    const sessionId = startSession(textId);
    const session = db.prepare('SELECT * FROM read_texts WHERE id = ?').get(sessionId);
    return { payload: sessionPayload(session, currentLevel()) };
  },

  /** 恢复上次没读完的文本。没有则返回 null。 */
  'GET /api/learn/current': () => {
    const session = currentSession();
    if (!session) return { payload: null };
    return { payload: sessionPayload(session, currentLevel()) };
  },

  /** 学习：选一篇真实文本，并开一个阅读会话 */
  'GET /api/learn/next': async ({ query }) => {
    const level = Number(query.level) || currentLevel();
    const cats = query.category ? [query.category] : currentCategories();

    const readIds = new Set(
      db.prepare('SELECT text_id FROM read_texts').all().map((r) => r.text_id),
    );

    const findOpts = {
      level,
      categories: cats,
      minWords: Number(query.minWords) || 140,
      maxWords: Number(query.maxWords) || 1200,
      excludeIds: query.reuse === '1' ? new Set() : readIds,
    };

    let text = pickLearnText(findOpts);

    // 池子不够就地拉最新的 RSS。这是同步等待，所以只用于「选不到文」的兜底；
    // 用户主动点击的「抓取新文章」走后台任务（/api/fetch/start）。
    let fetched = null;
    if (!text && query.live !== '0') {
      fetched = await ensurePool({ categories: cats, want: 8, perFeed: 8, maxPerFeed: 2, concurrency: 6 });
      text = pickLearnText(findOpts);
    }
    // 还没抓到合意的，放宽到「读过也可以重用」
    if (!text) {
      text = pickLearnText({ ...findOpts, excludeIds: new Set(), maxWords: 2000 });
    }

    if (!text) {
      return {
        payload: null,
        fetched,
        reason: '没有合适难度的文本',
      };
    }

    const sessionId = startSession(text.id);
    const session = db.prepare('SELECT * FROM read_texts WHERE id = ?').get(sessionId);

    return { payload: sessionPayload(session, level), fetched };
  },

  /**
   * 点击一个词 → 返回释义与其它真实文本中的例句。
   *
   * 默认排除「当前正在读的那一篇」：点开一个词，想知道的是它在**别处**怎么用，
   * 而不是刚刚看过的那句。这件事由服务端决定，客户端不必知道上下文。
   */
  'GET /api/word': ({ query }) => {
    const word = String(query.word || '').trim().toLowerCase();
    if (!word) throw new Error('缺少 word 参数');
    const current = currentSession();
    const exclude =
      query.excludeTextId !== undefined && query.excludeTextId !== ''
        ? Number(query.excludeTextId)
        : (current?.text_id ?? undefined);
    return wordDetail(
      word,
      exclude,
      query.level === undefined ? undefined : Number(query.level),
    );
  },

  'POST /api/learn/mark': async ({ body }) => {
    const word = String(body.word || '').trim().toLowerCase();
    if (!word) throw new Error('缺少 word');
    const card = markWord(word, body.textId ?? null, body.sentenceId ?? null);
    return { card, detail: wordDetail(word) };
  },

  'POST /api/learn/unmark': async ({ body }) => {
    const word = String(body.word || '').trim().toLowerCase();
    if (!word) throw new Error('缺少 word');
    return unmarkWord(word);
  },

  'POST /api/learn/finish': async ({ body }) => {
    const textId = Number(body.textId);
    if (!textId) throw new Error('缺少 textId');

    // 会话 id 优先；没传（比如从文本库直接结束）就找该文本未完成的那条
    const session =
      (body.sessionId
        ? db.prepare('SELECT * FROM read_texts WHERE id = ?').get(Number(body.sessionId))
        : null) ??
      db
        .prepare(
          "SELECT * FROM read_texts WHERE text_id = ? AND status = 'reading' ORDER BY started_at DESC LIMIT 1",
        )
        .get(textId);

    if (!session) {
      // 没有进行中的会话（比如重复提交），不要报错
      return { ok: true, alreadyFinished: true, marked: [] };
    }

    // 列要和 /api/words 对齐（含学习状态），这样摘要里的词表
    // 与单词本的行完全一致，不用客户端再造一个形状。
    const marked = db
      .prepare(`
        SELECT COALESCE(w.level, v.level) AS level,
               v.word, w.phonetic, w.pos, w.translation, w.tags, w.frq,
               v.reps, v.lapses, v.due_at, v.verified, v.interval_days, v.created_at
        FROM vocab v
        LEFT JOIN words w ON w.word = v.word
        WHERE v.status != 'archived'
          AND v.word IN (SELECT word FROM text_words WHERE text_id = ?)
        ORDER BY level DESC, v.word
      `)
      .all(textId)
      .map(toWordRow);

    // 标记数由服务端数，不信客户端传的值 ——
    // 客户端可能因为中途刷新而少报，库里的事实才是准的。
    // 同时把词表存进流水，列表里展开就能看到「这次标记了什么」。
    finishSession(session.id, marked.length, marked.map((m) => m.word));

    return { ok: true, sessionId: session.id, marked };
  },

  /** 复习：一次拿到「几篇文本 + 覆盖到的词」 */
  'GET /api/review/plan': ({ query }) => planReview({ size: Number(query.size) || 12 }),

  /** 复习评分 */
  'POST /api/review/grade': async ({ body }) => {
    const word = String(body.word || '').trim().toLowerCase();
    const gradeKey = String(body.grade || '');
    if (!word) throw new Error('缺少 word');
    if (!GRADES[gradeKey]) throw new Error(`未知评分 ${gradeKey}`);

    const card = db.prepare('SELECT * FROM vocab WHERE word = ?').get(word);
    if (!card) throw new Error(`词汇表中没有 ${word}`);

    const prev = card.interval_days ?? 0;
    const next = schedule(card, gradeKey, new Date());
    const now = new Date();

    db.prepare(`
      UPDATE vocab SET
        ease = ?, interval_days = ?, due_at = ?, reps = ?, lapses = ?,
        verified = ?, last_mode = ?, last_grade = ?, last_seen_at = ?
      WHERE word = ?
    `).run(
      next.ease,
      next.interval_days,
      next.due.toISOString(),
      next.reps,
      next.lapses,
      next.verified,
      GRADES[gradeKey].mode,
      gradeKey,
      now.toISOString(),
      word,
    );

    // 流水只追加：复习表已并入 activity，不再写第二份
    logActivity('review', {
      word,
      textId: body.textId ?? null,
      detail: {
        mode: GRADES[gradeKey].mode,
        grade: gradeKey,
        typed: body.typed ? String(body.typed).slice(0, 100) : null,
        // 有没有看过提示：影响这次「想起来了」的含金量，展开记录时要看得到
        usedHint: Boolean(body.usedHint),
        // 当时考的是哪一句。客户端手里有（刚出过这道题），记下来记录里才能回看
        sentenceId: body.sentenceId ? Number(body.sentenceId) : null,
        prev,
        next: next.interval_days,
      },
    });

    const updated = db.prepare('SELECT * FROM vocab WHERE word = ?').get(word);
    return {
      card: { ...updated, stage: stageOf(updated), stageName: STAGES[stageOf(updated)].name },
      intervalDays: next.interval_days,
      // 阅读模式的正确不计入「已完全记住」，前端据此提示用户
      countedAsVerified: next.verified === 1,
    };
  },

  /**
   * 统一的词表：词库与生词本是**同一个列表**。
   *
   * 列表 = 词典 ∪ 你学过的词。为什么不能只用 words 做主表：
   * 分词器会产生词典里没有的 lemma（如连字符复合词 space-dependent），
   * 只 LEFT JOIN words 的话，你标记过的词会从列表里消失，
   * 而且阶段计数会和列表对不上。
   *
   * 不用「把缺的 lemma 插进 words」来解决：那会把语料推导出的数据
   * 混进词典表，改了分级规则后还会留下陈旧的等级。
   *
   * stage: all | none(未学) | new | reading | learning | mature
   */
  'GET /api/words': ({ query }) => {
    const q = String(query.q || '').trim().toLowerCase();
    const stage = String(query.stage || 'all');
    const limit = Math.min(Number(query.limit) || 25, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const STAGE_SQL = {
      none: 'v.word IS NULL',
      new: 'v.word IS NOT NULL AND v.reps = 0',
      reading: 'v.word IS NOT NULL AND v.reps > 0 AND v.verified = 0',
      learning: 'v.word IS NOT NULL AND v.verified = 1 AND v.interval_days < 21',
      mature: 'v.word IS NOT NULL AND v.interval_days >= 21',
    };
    if (stage !== 'all' && !STAGE_SQL[stage]) throw new Error(`未知的阶段 ${stage}`);

    // ---- 主分支：词典里的词，LEFT JOIN 出学习状态
    const mainWhere = [];
    const mainParams = [];
    if (q) {
      mainWhere.push('w.word LIKE ?');
      mainParams.push(`${q}%`);
    }
    if (stage !== 'all') mainWhere.push(STAGE_SQL[stage]);

    // ---- 补充分支：学过的、但词典里没有的词（如 space-dependent）
    // stage=none 时这个分支必然是空的，直接不拼
    const extraParams = [];
    let extraBranch = '';
    if (stage !== 'none') {
      const extraWhere = [
        "v.status != 'archived'",
        'NOT EXISTS (SELECT 1 FROM words w2 WHERE w2.word = v.word)',
      ];
      if (q) {
        extraWhere.push('v.word LIKE ?');
        extraParams.push(`${q}%`);
      }
      if (stage !== 'all') {
        // 补充分支的行都来自 vocab，所以 v.word 必然非空
        extraWhere.push(STAGE_SQL[stage].replace(/v\.word IS NULL/g, '0'));
      }
      extraBranch = `
        UNION ALL
        SELECT v.word, v.level, NULL AS phonetic, NULL AS pos, NULL AS translation,
               NULL AS tags, 0 AS frq,
               v.reps, v.lapses, v.due_at, v.verified, v.interval_days, v.created_at
        FROM vocab v
        WHERE ${extraWhere.join(' AND ')}
      `;
    }

    const union = `
      SELECT w.word, w.level, w.phonetic, w.pos, w.translation, w.tags, w.frq,
             v.reps, v.lapses, v.due_at, v.verified, v.interval_days, v.created_at
      FROM words w
      LEFT JOIN vocab v ON v.word = w.word AND v.status != 'archived'
      ${mainWhere.length ? `WHERE ${mainWhere.join(' AND ')}` : ''}
      ${extraBranch}
    `;

    // 有搜索词：精确匹配优先 → 前缀长度 → 字母序
    // 无搜索词：学过的排前面（最近的在前），其余按词频
    const order = q
      ? 'ORDER BY CASE WHEN word = ? THEN 0 ELSE 1 END, LENGTH(word), word'
      : `ORDER BY (reps IS NULL), created_at DESC,
                 (CASE WHEN frq > 0 THEN frq ELSE 999999 END), word`;
    const orderParams = q ? [q] : [];

    const params = [...mainParams, ...extraParams];
    const total = db.prepare(`SELECT COUNT(*) AS c FROM (${union})`).get(...params).c;
    const rows = db
      .prepare(`SELECT * FROM (${union}) ${order} LIMIT ? OFFSET ?`)
      .all(...params, ...orderParams, limit, offset);

    const items = rows.map(toWordRow);

    return { items, total, offset, limit };
  },

  /**
   * 各阶段的词量。
   *
   * 必须和 /api/words 用同一个口径（词典 ∪ 学过的词），
   * 否则筛选条上的数字会和列表对不上。
   */
  'GET /api/words/stages': () => {
    const total = db
      .prepare(`
        SELECT (SELECT COUNT(*) FROM words)
             + (SELECT COUNT(*) FROM vocab v
                WHERE v.status != 'archived'
                  AND NOT EXISTS (SELECT 1 FROM words w WHERE w.word = v.word)) AS c
      `)
      .get().c;

    const one = (sql) => db.prepare(`SELECT COUNT(*) AS c FROM vocab v WHERE ${sql}`).get().c;
    const newCount = one("status != 'archived' AND reps = 0");
    const reading = one("status != 'archived' AND reps > 0 AND verified = 0");
    const learning = one("status != 'archived' AND verified = 1 AND interval_days < 21");
    const mature = one("status != 'archived' AND interval_days >= 21");

    return {
      all: total,
      // 「无数据」= 列表总数 − 学过的词数
      none: total - (newCount + reading + learning + mature),
      new: newCount,
      reading,
      learning,
      mature,
    };
  },

  /** 文本库：所有读过的/在读的/未读的文本 */
  'GET /api/texts': ({ query }) => {
    const filter = String(query.filter || 'all');
    const limit = Math.min(Number(query.limit) || 60, 300);
    const offset = Math.max(Number(query.offset) || 0, 0);
    return {
      items: textLibrary({ filter, limit, offset }),
      total: textLibraryCount(filter),
      counts: {
        all: textLibraryCount('all'),
        reading: textLibraryCount('reading'),
        done: textLibraryCount('done'),
        unread: textLibraryCount('unread'),
      },
    };
  },

  /**
   * 文本详情（侧边栏用）。
   * 注意：**不开阅读会话** —— 浏览文本库不应该抢掉当前正在读的那篇，
   * 只有用户明确点「设为当前阅读」才会。
   */
  'GET /api/texts/detail': ({ query }) => {
    const id = Number(query.id);
    if (!id) throw new Error('缺少 id');

    const meta = db
      .prepare(`
        SELECT t.id, t.source, t.category, t.title, t.url, t.published, t.fetched_at,
               t.word_count, t.avg_level,
               ls.id AS session_id, ls.status, ls.started_at, ls.finished_at, ls.n_marked,
               (SELECT COUNT(*) FROM read_texts r WHERE r.text_id = t.id AND r.status = 'done') AS times_read
        FROM texts t
        LEFT JOIN read_texts ls
               ON ls.id = (SELECT r2.id FROM read_texts r2 WHERE r2.text_id = t.id
                           ORDER BY (r2.status = 'reading') DESC, r2.started_at DESC LIMIT 1)
        WHERE t.id = ?
      `)
      .get(id);
    if (!meta) throw new Error('文本不存在');

    const current = currentSession();

    return {
      meta,
      markedWords: markedWordsOf(id, true),
      isCurrent: Boolean(current && current.text_id === id),
      // 不返回 segments：正文只在主视图（阅读页）渲染。
      // 面板是「看一眼」的地方，把整篇分词传过来既浪费又溢出职责
      // （实测这一项占载荷的 99.5%：91.4 KB / 91.9 KB）。
    };
  },

  /** append-only 流水：可按词或按文本筛 */
  'GET /api/activity': ({ query }) => {
    const limit = Math.min(Number(query.limit) || 30, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const wheres = [];
    const params = [];
    if (query.word) {
      wheres.push('a.word = ?');
      params.push(String(query.word).toLowerCase());
    }
    if (query.textId) {
      wheres.push('a.text_id = ?');
      params.push(Number(query.textId));
    }
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM activity a ${where}`).get(...params).c;
    const items = db
      .prepare(`
        SELECT a.id, a.at, a.kind, a.word, a.text_id, a.detail,
               t.title, t.source, t.category,
               s.text AS sentence
        FROM activity a
        LEFT JOIN texts t ON t.id = a.text_id
        LEFT JOIN sentences s ON s.id = json_extract(a.detail, '$.sentenceId')
        ${where}
        ORDER BY a.at DESC, a.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset)
      .map((r) => ({ ...r, detail: safeJson(r.detail) }));

    return { items, total, offset, limit };
  },

  /**
   * 单篇正文（带分词）。
   *
   * 和 /api/texts/detail 分开：只有展开「查看原文」时才需要它，
   * 平时拉详情不该背上几十 KB 的正文（当初正是为此把它们拆开的）。
   */
  'GET /api/texts/body': ({ query }) => {
    const textId = Number(query.textId);
    if (!textId) throw new Error('缺少 textId');
    const text = attachAnalysis(textId);
    if (!text) throw new Error('文本不存在');
    return {
      textId,
      segments: text.segments,
      boilerplateFrom: boilerplateStart(text.body),
    };
  },

  /** 一条记录里原句的分词（展开那条记录时才拉） */
  'GET /api/activity/sentence': ({ query }) => {
    const sentenceId = Number(query.id);
    if (!sentenceId) throw new Error('缺少 id');
    return sentenceDetail(sentenceId);
  },

  'GET /api/sources': () => ({
    feeds: FEEDS.map((f) => ({ ...f })),
    categories: CATEGORIES,
  }),

  /**
   * 抓取新文章：**立即返回**，抓取在后台跑。
   *
   * 不能同步等待 —— 抓十几篇要几十秒，nginx 会把超时的请求直接断开，
   * 前端只会得到一个网络错误。所以这里只建一条任务记录就返回，
   * 进度靠轮询 /api/fetch/status。
   */
  'POST /api/fetch/start': ({ body }) => {
    const cats = body.categories?.length ? body.categories : currentCategories();
    return startFetchJob({ categories: cats, want: Number(body.want) || 12 });
  },

  /** 抓取任务状态。刷新页面后靠它恢复「正在抓取」的状态。 */
  'GET /api/fetch/status': () => ({
    job: runningJob('fetch') ?? latestJob('fetch'),
    corpus: db.prepare('SELECT COUNT(*) AS c FROM texts').get().c,
  }),

  'GET /api/text': ({ query }) => {
    const id = Number(query.id);
    if (!id) throw new Error('缺少 id');
    const t = attachAnalysis(id);
    if (!t) throw new Error('文本不存在');
    return { text: t };
  },
};

// ---------------------------------------------------------------- 静态资源

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 发送前端静态文件。
 * @param {http.ServerResponse} res
 * @param {string} pathname
 */
function serveStatic(res, pathname) {
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建。开发模式请访问 Vite 的地址，或先运行 npm run build。');
    return true;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.join(DIST_DIR, rel);
  // 防目录穿越
  if (!file.startsWith(DIST_DIR)) file = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST_DIR, 'index.html');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------------------------------------------------------------- 启动

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];

  if (!handler) {
    if (url.pathname.startsWith('/api/')) {
      json(res, { error: `未知接口 ${key}` }, 404);
      return;
    }
    serveStatic(res, url.pathname);
    return;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams.entries());
    const result = await handler({ body, query, req, res });
    json(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${key}] ${message}`);
    json(res, { error: message }, 400);
  }
});

server.listen(PORT, () => {
  const corpus = db.prepare('SELECT COUNT(*) AS c FROM texts').get().c;
  const words = db.prepare('SELECT COUNT(*) AS c FROM words').get().c;
  console.log(`词库 ${words.toLocaleString()} 词 · 语料 ${corpus} 篇`);
  console.log(`API  http://localhost:${PORT}`);
  if (!fs.existsSync(DIST_DIR)) {
    console.log('提示：开发模式请另开终端运行 npm run dev:web');
  }
});
