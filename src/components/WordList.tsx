import { useCallback, useEffect, useRef, useState } from 'react';
import { api, PAGE } from '../api';
import { useDelayedFlag } from '../hooks/useDelayedFlag';
import { setParams, useRoute } from '../router';
import { levelVar } from '../types';
import type { Paged, StageCounts, WordRequest, WordRow } from '../types';
import { Pager } from './Pager';
import { Spinner } from './Spinner';

interface Props {
  onOpenWord: (r: WordRequest) => void | Promise<void>;
}

/** 阶段筛选。none = 从未学过。 */
const STAGE_CHIPS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'none', label: '无数据' },
  { key: 'new', label: '新词' },
  { key: 'reading', label: '待验证' },
  { key: 'learning', label: '学习中' },
  { key: 'mature', label: '已掌握' },
];

const STAGE_CLS: Record<string, string> = {
  new: 'pill',
  reading: 'pill reading',
  learning: 'pill science',
  mature: 'pill academic',
};

/**
 * 词库与生词本是**同一个列表**。
 *
 * 以词表为主，所以没学过的词也在里面 —— 阶段显示「无数据」，
 * 复习与下次留空。搜索与阶段筛选都作用在这一个列表上，
 * 不必先想「这个词我标过没有，该去哪个页签找」。
 */
export function WordList({ onOpenWord }: Props) {
  // 搜索词、阶段筛选、页码都住在 URL 里
  const route = useRoute();
  const q = route.params.get('q') ?? '';
  const stage = route.params.get('stage') ?? 'all';
  const page = Math.max(1, Number(route.params.get('page')) || 1);
  const offset = (page - 1) * PAGE;

  const [rows, setRows] = useState<Paged<WordRow> | null>(null);
  const [counts, setCounts] = useState<StageCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 数据版本号：只在新数据到位时 +1，用它作列表的 key 来重播进场动画。
   * 拿筛选条件／页码当 key 会让动画播在旧数据上。
   */
  const [gen, setGen] = useState(0);
  /**
   * 加载态从「请求真的发出去了」开始算，而不是从参数变化算。
   * 搜索框有 220ms 防抖，算进去的话每敲一个键都会闪一次转圈。
   */
  const [fetching, setFetching] = useState(false);
  const loading = useDelayedFlag(fetching, 150);
  const reqId = useRef(0);

  const loadCounts = useCallback(async () => {
    try {
      setCounts(await api.wordsStages());
    } catch {
      /* 计数失败不影响列表 */
    }
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  // 输入即搜（防抖 220ms）—— 40 万词条，不值得让用户按回车
  const prevQ = useRef(q);
  useEffect(() => {
    // 防抖只对「改搜索词」生效。翻页和换筛选没有理由白等 220ms ——
    // 那是为连打的键盘准备的，点按钮是单次明确意图。
    const qChanged = prevQ.current !== q;
    prevQ.current = q;

    const id = ++reqId.current;
    const timer = setTimeout(() => {
      setFetching(true);
      void (async () => {
        try {
          const r = await api.words({ q, stage, offset, limit: PAGE });
          if (reqId.current !== id) return;
          setRows(r);
          setError(null);
          setGen((g) => g + 1);
        } catch (e) {
          if (reqId.current === id) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (reqId.current === id) setFetching(false);
        }
      })();
    }, qChanged ? 220 : 0);
    return () => clearTimeout(timer);
  }, [q, stage, offset]);

  const pickStage = (key: string) => {
    setParams({ stage: key === 'all' ? undefined : key, page: undefined });
  };

  const onSearch = (value: string) => {
    // 搜索框用 replace + 防抖：否则每敲一个键都压一条历史，退回去要按十几次
    setParams({ q: value.trim() ? value : undefined, page: undefined }, { replace: true });
  };

  const goPage = (nextOffset: number) => {
    const p = Math.floor(nextOffset / PAGE) + 1;
    setParams({ page: p === 1 ? undefined : p });
  };

  return (
    <div className="wrap">
      <div className="page">
        <div className="toolbar">
          <h2 className="page-title">单词</h2>
          <input
            className="search"
            value={q}
            placeholder="搜索单词"
            onChange={(e) => onSearch(e.target.value)}
          />
          {rows && <span className="muted">共 {rows.total}</span>}
        </div>

        <div className="chips chips-wrap">
          {STAGE_CHIPS.map((c) => (
            <button
              key={c.key}
              className={`chip${stage === c.key ? ' on' : ''}`}
              onClick={() => pickStage(c.key)}
            >
              {c.label}
              {counts && <span className="chip-n">{counts[c.key as keyof StageCounts]}</span>}
            </button>
          ))}
        </div>

        {error && <div className="error">{error}</div>}

        {/* 加载中：用换文章那个加载动画占位（全局统一这一个指示器） */}
        {loading && (
          <div className="loading">
            <Spinner />
          </div>
        )}

        {!loading && rows?.total === 0 && <p className="empty">没有匹配的词</p>}

        {!loading && rows && rows.total > 0 && (
          /* key 用数据版本号：新数据到位才重播进场动画 */
          <table className="table list-anim" key={gen}>
            <thead>
              <tr>
                <th>单词</th>
                <th>释义</th>
                <th>阶段</th>
                <th>复习</th>
                <th>下次</th>
              </tr>
            </thead>
            <tbody>
              {rows.items.map((w) => (
                <tr
                  key={w.word}
                  className="dict-row"
                  onClick={() => void onOpenWord({ word: w.word, level: w.level })}
                >
                  <td className="word-cell" style={{ color: levelVar(w.level) }}>
                    {w.word}
                  </td>
                  <td className="trans-cell">
                    {(w.translation ?? '').split('\\n')[0].slice(0, 90) || '—'}
                  </td>
                  <td>
                    {/* 没学过就没有阶段可言 —— 写「无数据」而不是留白，
                        否则会让人以为是加载失败 */}
                    {w.studied ? (
                      <span className={STAGE_CLS[w.stage] ?? 'pill'}>{w.stageName}</span>
                    ) : (
                      <span className="muted">无数据</span>
                    )}
                  </td>
                  {w.studied ? (
                    <>
                      <td className="num-cell">
                        {w.reps}
                        {(w.lapses ?? 0) > 0 && <span className="muted"> / 忘 {w.lapses}</span>}
                      </td>
                      <td className="muted">{dueLabel(w)}</td>
                    </>
                  ) : (
                    <>
                      <td />
                      <td />
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && rows && (
          <Pager total={rows.total} offset={offset} limit={PAGE} onChange={goPage} />
        )}
      </div>
    </div>
  );
}

function dueLabel(w: WordRow): string {
  if (!w.due_at) return '—';
  const diff = new Date(w.due_at).getTime() - Date.now();
  if (diff <= 0) return '到期';
  const days = diff / 86400000;
  if (days < 1) return `${Math.round(days * 24)} 小时后`;
  return `${days.toFixed(days < 3 ? 1 : 0)} 天后`;
}
