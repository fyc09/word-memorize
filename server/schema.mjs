/**
 * 数据库 schema 与迁移。
 *
 * 全部用 IF NOT EXISTS，所以 ensureSchema() 可以反复执行；
 * 服务端每次启动都会调一次，老库就地补上新表与新列，不需要重建
 * —— 重建会丢掉语料（feed 只暴露最近几十条，重抓必然缩水）。
 *
 * 执行顺序是必须的：建表 → 补列 → 建索引。
 * 反过来的话，在一个还没有 status 列的老 read_texts 上执行
 * `CREATE INDEX ... ON read_texts(status)` 会直接报 no such column。
 */

/** 第一步：建表。 */
const TABLES = `
-- ---------------------------------------------------------------- 词库
CREATE TABLE IF NOT EXISTS words (
  word        TEXT PRIMARY KEY,
  level       INTEGER NOT NULL,
  phonetic    TEXT,
  pos         TEXT,
  translation TEXT,
  definition  TEXT,
  frq         INTEGER DEFAULT 0,
  bnc         INTEGER DEFAULT 0,
  collins     INTEGER DEFAULT 0,
  oxford      INTEGER DEFAULT 0,
  tags        TEXT,
  exchange    TEXT
);

CREATE TABLE IF NOT EXISTS lemma (
  form     TEXT PRIMARY KEY,
  base     TEXT NOT NULL,
  freq     INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------- 语料
CREATE TABLE IF NOT EXISTS texts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  category     TEXT NOT NULL,
  title        TEXT,
  url          TEXT UNIQUE,
  published    TEXT,
  fetched_at   TEXT NOT NULL,
  body         TEXT NOT NULL,
  word_count   INTEGER NOT NULL,
  avg_level    REAL NOT NULL,
  dist         TEXT NOT NULL,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS sentences (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  text_id INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  text    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sentence_words (
  sentence_id INTEGER NOT NULL,
  word        TEXT NOT NULL,
  PRIMARY KEY (sentence_id, word)
);

CREATE TABLE IF NOT EXISTS text_words (
  text_id INTEGER NOT NULL,
  word    TEXT NOT NULL,
  cnt     INTEGER NOT NULL,
  level   INTEGER NOT NULL,
  PRIMARY KEY (text_id, word)
);

-- ---------------------------------------------------------------- 学习状态
-- vocab 与 read_texts 是**当前状态**（会被更新）；
-- activity / jobs 是流水，只追加。
CREATE TABLE IF NOT EXISTS vocab (
  word              TEXT PRIMARY KEY,
  level             INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'learning',
  first_text_id     INTEGER,
  first_sentence_id INTEGER,
  created_at        TEXT NOT NULL,
  ease              REAL NOT NULL DEFAULT 2.5,
  interval_days     REAL NOT NULL DEFAULT 0,
  due_at            TEXT,
  reps              INTEGER NOT NULL DEFAULT 0,
  lapses            INTEGER NOT NULL DEFAULT 0,
  -- 是否通过「填空」验证过。阅读模式的成功不算完全记住，
  -- 这里保持 0，直到用户在某次填空复习中真正想起来了。
  verified          INTEGER NOT NULL DEFAULT 0,
  last_mode         TEXT,
  last_grade        TEXT,
  last_seen_at      TEXT
);

/**
 * 阅读会话：一篇文本每读一次就是一行。
 *
 * status = 'reading' 的那行就是「当前正在读的文本」—— 刷新后据此恢复，
 * 不再额外存一个 current_text_id（两处状态早晚会不同步）。
 */
CREATE TABLE IF NOT EXISTS read_texts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text_id     INTEGER NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'learn',
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  n_marked    INTEGER DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'reading'
);

/**
 * 统一 append-only 活动流。
 *
 * 学习、复习、标记、抓取全部写这里，不写第二份 —— 生词本的「历史」
 * 与文本库的「记录」都是查它。两张并行日志早晚会对不上。
 *
 * kind: read_start | read_done | mark | unmark | review | fetch
 */
CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  word    TEXT,
  text_id INTEGER,
  detail  TEXT
);

/**
 * 后台任务。
 *
 * 抓取要「立刻返回、后台跑」，状态必须落库而不是放内存 ——
 * 否则刷新页面后就看不到「正在抓取」了，而任务其实还在跑。
 * 同时 nginx 会掐超时的长请求，HTTP 层绝不能等抓取跑完。
 */
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  progress    TEXT,
  result      TEXT,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 第三步：建索引。必须等 migrate() 补完列之后再跑。 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_words_level ON words(level);
CREATE INDEX IF NOT EXISTS idx_lemma_base ON lemma(base);

CREATE INDEX IF NOT EXISTS idx_texts_cat ON texts(category, word_count);
CREATE INDEX IF NOT EXISTS idx_texts_fetched ON texts(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentences_text ON sentences(text_id, seq);
CREATE INDEX IF NOT EXISTS idx_sw_word ON sentence_words(word);
CREATE INDEX IF NOT EXISTS idx_tw_word ON text_words(word);
CREATE INDEX IF NOT EXISTS idx_tw_level ON text_words(word, level);

CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab(due_at);
CREATE INDEX IF NOT EXISTS idx_vocab_status ON vocab(status);
CREATE INDEX IF NOT EXISTS idx_read_texts_status ON read_texts(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_read_texts_text ON read_texts(text_id);

CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_word ON activity(word, at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_text ON activity(text_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity(kind, at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, started_at DESC);
`;

/** 表是否存在。 */
function hasTable(db, name) {
  return Boolean(
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

/** 某表是否有某列。 */
function hasColumn(db, table, column) {
  const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
  return cols.some((c) => c.name === column);
}

/**
 * 第二步：把老库就地补到当前 schema。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrate(db) {
  if (hasTable(db, 'read_texts') && !hasColumn(db, 'read_texts', 'status')) {
    db.exec("ALTER TABLE read_texts ADD COLUMN status TEXT NOT NULL DEFAULT 'reading'");
    db.exec("UPDATE read_texts SET status = 'done' WHERE finished_at IS NOT NULL");
  }

  // 旧的 encounters / reviews 并入 activity 后删除。
  // 两张表都只追加不改，语义与 activity 完全重合，
  // 留着只会让人不知道该读哪张。
  if (hasTable(db, 'encounters')) {
    db.exec(`
      INSERT INTO activity (at, kind, word, text_id, detail)
      SELECT created_at, 'mark', word, text_id,
             CASE WHEN sentence_id IS NULL THEN NULL
                  ELSE json_object('sentenceId', sentence_id) END
      FROM encounters
      WHERE word IS NOT NULL
    `);
    db.exec('DROP TABLE encounters');
  }

  if (hasTable(db, 'reviews')) {
    db.exec(`
      INSERT INTO activity (at, kind, word, text_id, detail)
      SELECT created_at, 'review', word, text_id,
             json_object('mode', mode, 'grade', grade, 'typed', typed,
                         'prev', prev_interval, 'next', next_interval)
      FROM reviews
      WHERE word IS NOT NULL
    `);
    db.exec('DROP TABLE reviews');
  }
}

/**
 * 建表 / 补列 / 建索引。可反复调用。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(TABLES);
  migrate(db);
  db.exec(INDEXES);
}
