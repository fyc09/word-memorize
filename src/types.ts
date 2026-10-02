/**
 * 打开一个词。level 是它在正文里被标成的等级，用于让卡片与刚看到的颜色一致。
 *
 * 不再携带 textId：例句要排除哪一篇由服务端根据「当前阅读会话」决定，
 * 客户端不需要（也不应该）知道这个上下文。
 */
export type WordRequest = { word: string; level?: number };

/** 与后端共享的类型定义。 */

export interface Level {
  level: number;
  key: string;
  name: string;
  short: string;
}

export interface Stage {
  key: string;
  name: string;
  desc: string;
}

export interface Segment {
  kind: 'word' | 'other';
  text: string;
  start: number;
  end: number;
  word?: string;
  level?: number;
}

export interface TextMeta {
  id: number;
  source: string;
  category: 'news' | 'science' | 'academic';
  title: string | null;
  url: string | null;
  published: string | null;
  word_count: number;
  avg_level: number;
  dist: number[];
  body?: string;
  segments?: Segment[];
  unknownRate?: number;
  unknownCount?: number;
}

export interface Example {
  sentenceId: number;
  textId: number;
  sentence: string;
  /** 分词结果：例句要和正文一样按难度着色、可点查词，而客户端没有词典 */
  segments?: Segment[];
  title: string | null;
  source: string;
  category: string;
}

export interface VocabCard {
  word: string;
  level: number;
  status: string;
  first_text_id: number | null;
  first_sentence_id: number | null;
  created_at: string;
  ease: number;
  interval_days: number;
  due_at: string | null;
  reps: number;
  lapses: number;
  verified: number;
  last_mode: string | null;
  last_grade: string | null;
  last_seen_at: string | null;
  stage?: string;
  stageName?: string;
  translation?: string | null;
  phonetic?: string | null;
}

export interface WordDetail {
  word: string;
  found: boolean;
  level: number;
  levelName: string;
  phonetic: string | null;
  pos: string | null;
  translation: string | null;
  definition: string | null;
  tags: string[];
  variants: { label: string; form: string }[];
  examples: Example[];
  /** 例句里哪些词在生词本里（服务端按全局口径标出） */
  markedWords: string[];
  card: VocabCard | null;
  /** append-only 流水里与这个词相关的条目 */
  history: ActivityItem[];
}

/** 文本库列表项：每篇带最近一次阅读会话的进度。 */
export interface TextListItem {
  id: number;
  source: string;
  category: 'news' | 'science' | 'academic';
  title: string | null;
  url: string | null;
  published: string | null;
  fetched_at: string;
  word_count: number;
  avg_level: number;
  session_id: number | null;
  status: 'reading' | 'done' | 'dropped' | null;
  started_at: string | null;
  finished_at: string | null;
  n_marked: number | null;
  times_read: number;
}

export interface ActivityItem {
  id: number;
  at: string;
  kind: 'read_start' | 'read_done' | 'mark' | 'unmark' | 'review' | 'fetch';
  word: string | null;
  text_id: number | null;
  detail: ActivityDetail | null;
  title?: string | null;
  source?: string | null;
  category?: string | null;
}

/**
 * 流水的补充字段。
 *
 * 不同 kind 用不同字段，全部可选 —— 展开一条记录时要能回答：
 *   复习：是填空还是阅读？看了提示吗？当时填的是什么？
 *   读完：这次标记了哪些词？
 */
export interface ActivityDetail {
  // review
  mode?: 'cloze' | 'reading';
  grade?: string;
  typed?: string | null;
  usedHint?: boolean;
  prev?: number;
  next?: number;
  // read_done
  nMarked?: number;
  words?: string[];
  // mark / unmark
  sentenceId?: number | null;
  archived?: boolean;
  // fetch
  scanned?: number;
  ingested?: number;
  failed?: number;
}

/** 分页响应。 */
export interface Paged<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/** 文本详情（侧边栏文本面板）。不会开阅读会话。 */
export interface TextDetail {
  meta: TextListItem;
  markedWords: { word: string; level: number }[];
  isCurrent: boolean;
  segments: Segment[];
}

/**
 * 统一词表里的一行。
 *
 * 没学过的词也在列表里（studied=false）：阶段为「无数据」，
 * reps / due_at 等字段为 null，界面留空。
 */
export interface WordRow {
  word: string;
  level: number;
  phonetic: string | null;
  pos: string | null;
  translation: string | null;
  tags: string | null;
  reps: number | null;
  lapses: number | null;
  due_at: string | null;
  verified: number | null;
  interval_days: number | null;
  studied: boolean;
  stage: 'none' | 'new' | 'reading' | 'learning' | 'mature';
  stageName: string;
}

/** 各阶段的词量，用于筛选条上的计数。 */
export interface StageCounts {
  all: number;
  none: number;
  new: number;
  reading: number;
  learning: number;
  mature: number;
}

export interface FetchJob {
  id: number;
  kind: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt: string | null;
  progress: Record<string, unknown> | null;
  result: { scanned?: number; ingested?: number; failed?: number } | null;
  error: string | null;
}

/** 一次阅读会话的完整负载。 */
export interface LearnPayload {
  session: { id: number; startedAt: string; finishedAt: string | null; status: string };
  text: TextMeta & { segments: Segment[]; unknownRate: number; unknownCount: number };
  markedWords: string[];
}

/** 读完一篇后返回的「本篇标记词释义面板」条目。 */
export interface MarkedEntry {
  word: string;
  level: number;
  phonetic: string | null;
  pos: string | null;
  translation: string | null;
  tags: string[];
}

export interface AppState {
  level: number;
  categories: string[];
  levels: Level[];
  stages: Record<string, Stage>;
  categoriesMeta: Record<string, { key: string; name: string; desc: string }>;
  vocab: {
    total: number | null;
    due: number;
    unverified: number | null;
    verified: number | null;
    mature: number | null;
    reviewed: number | null;
  };
  reviews: { total: number | null; cloze: number | null; reading: number | null; ok: number | null };
  corpus: { texts: number; readTexts: number; reading: number; unread: number };
  /** 当前抓取任务（若有），用于刷新后恢复「正在抓取」状态 */
  fetchJob: FetchJob | null;
}

export interface ReviewItem {
  word: string;
  textId: number;
  sentenceId: number;
  sentence: string;
  blanked: string;
  answer: string;
  context: string;
  level: number;
  translation: string | null;
  phonetic: string | null;
  pos: string | null;
  stage: 'new' | 'reading' | 'learning' | 'mature';
  reps: number;
  lapses: number;
  /** true 表示没能换到新语境，只能复用学习时那篇文章的另一个句子 */
  reusedContext: boolean;
}

export interface ReviewPlan {
  texts: (TextMeta & { covers: number; targetWords: string[]; reused: boolean })[];
  items: ReviewItem[];
  dueCount: number;
  uncovered: number;
}

export function levelVar(level: number): string {
  return `var(--lv${level})`;
}

export type GradeKey =
  | 'cloze_good'
  | 'cloze_fuzzy'
  | 'cloze_fail'
  | 'reading_good'
  | 'reading_fail';
