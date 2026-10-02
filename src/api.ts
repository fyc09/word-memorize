import type {
  ActivityItem,
  AppState,
  FetchJob,
  GradeKey,
  LearnPayload,
  Paged,
  ReviewPlan,
  StageCounts,
  TextDetail,
  TextListItem,
  VocabCard,
  WordDetail,
  WordRow,
} from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`接口返回不是 JSON：${path}`);
  }
  const asError = data as { error?: string } | null;
  if (!res.ok || asError?.error) {
    throw new Error(asError?.error ?? `请求失败 ${res.status}`);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  req<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** 每页条数。列表全部走分页，不用「加载更多」。 */
export const PAGE = 25;

export const api = {
  state: () => req<AppState>('/api/state'),

  setSettings: (patch: { level?: number; categories?: string[]; showLevels?: boolean }) =>
    post<{ level: number; categories: string[]; showLevels: boolean }>('/api/settings', patch),

  // ------------------------------------------------------------ 阅读

  /** 恢复上次没读完的文本（刷新后续读） */
  current: () => req<{ payload: LearnPayload | null }>('/api/learn/current'),

  /** 取下一篇；服务端会同时开一个阅读会话 */
  learnNext: (opts: { live?: boolean; category?: string } = {}) =>
    req<{ payload: LearnPayload | null; fetched: { ingested?: number } | null; reason?: string }>(
      `/api/learn/next${qs({ live: opts.live === false ? '0' : undefined, category: opts.category })}`,
    ),

  /** 把某一篇设为当前阅读（会开新会话）。只应由「设为当前阅读」按钮调用。 */
  openText: (textId: number) =>
    post<{ payload: LearnPayload | null }>('/api/learn/open', { textId }),

  finish: (textId: number, sessionId?: number) =>
    post<{ ok: boolean; sessionId?: number; marked: WordRow[]; alreadyFinished?: boolean }>(
      '/api/learn/finish',
      { textId, sessionId },
    ),

  // ------------------------------------------------------------ 单词

  /**
   * 词条详情。例句会自动排除「当前正在读的那一篇」，
   * 这样点开一个词看到的总是其它文章里的用法。
   */
  word: (word: string, level?: number) =>
    req<WordDetail>(`/api/word${qs({ word, level })}`),

  /** textId 可缺 —— 从词库/生词本里标记时并没有「出自哪篇」的上下文 */
  mark: (word: string, textId?: number, sentenceId?: number) =>
    post<{ card: VocabCard; detail: WordDetail }>('/api/learn/mark', { word, textId, sentenceId }),

  unmark: (word: string) => post<{ removed: boolean }>('/api/learn/unmark', { word }),

  /**
   * 统一词表：词库与生词本是同一个列表，没学过的词也在里面。
   * stage: all | none(未学) | new | reading | learning | mature
   */
  words: (opts: { q?: string; stage?: string; offset?: number; limit?: number } = {}) =>
    req<Paged<WordRow>>(
      `/api/words${qs({
        q: opts.q ?? '',
        stage: opts.stage && opts.stage !== 'all' ? opts.stage : undefined,
        offset: opts.offset ?? 0,
        limit: opts.limit ?? PAGE,
      })}`,
    ),

  /** 各阶段的词量（筛选条上的计数） */
  wordsStages: () => req<StageCounts>('/api/words/stages'),

  // ------------------------------------------------------------ 文本库

  texts: (opts: { filter?: 'all' | 'reading' | 'done' | 'unread'; offset?: number; limit?: number } = {}) =>
    req<Paged<TextListItem> & { counts: { all: number; reading: number; done: number; unread: number } }>(
      `/api/texts${qs({
        filter: opts.filter ?? 'all',
        offset: opts.offset ?? 0,
        limit: opts.limit ?? PAGE,
      })}`,
    ),

  /** 文本详情。不开阅读会话 —— 浏览不该抢掉当前正在读的那篇。 */
  textDetail: (id: number) => req<TextDetail>(`/api/texts/detail${qs({ id })}`),

  // ------------------------------------------------------------ 复习

  reviewPlan: (size = 12) => req<ReviewPlan>(`/api/review/plan${qs({ size })}`),

  grade: (args: {
    word: string;
    textId?: number;
    grade: GradeKey;
    typed?: string;
    usedHint?: boolean;
  }) => post<{ card: VocabCard; intervalDays: number; countedAsVerified: boolean }>(
    '/api/review/grade',
    args,
  ),

  // ------------------------------------------------------------ 记录与任务

  activity: (opts: { word?: string; textId?: number; offset?: number; limit?: number } = {}) =>
    req<Paged<ActivityItem>>(
      `/api/activity${qs({
        word: opts.word,
        textId: opts.textId,
        offset: opts.offset ?? 0,
        limit: opts.limit ?? PAGE,
      })}`,
    ),

  fetchStart: (want = 12) =>
    post<{ job: FetchJob; alreadyRunning: boolean }>('/api/fetch/start', { want }),

  fetchStatus: () => req<{ job: FetchJob | null; corpus: number }>('/api/fetch/status'),
};
