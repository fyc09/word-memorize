import { useCallback, useEffect, useState } from 'react';
import { api, PAGE } from '../api';
import { useDelayedFlag } from '../hooks/useDelayedFlag';
import { setParams, useRoute } from '../router';
import type { TextListItem } from '../types';
import { Pager } from './Pager';
import { Spinner } from './Spinner';

interface Props {
  /** 点开某篇 → 打开侧边栏文本面板（不会抢占当前阅读） */
  onOpenText: (id: number) => void;
  onStateChange: () => void | Promise<void>;
}

type Filter = 'all' | 'reading' | 'done' | 'unread';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'done', label: '已读' },
  { key: 'unread', label: '未读' },
];

/** 查表比嵌套三元好读，也不容易漏掉分支。 */
const CATEGORY_LABEL: Record<string, string> = {
  news: '新闻',
  science: '科普',
  academic: '学术',
};

const STATUS_LABEL: Record<string, string> = {
  reading: '在读',
  done: '已读',
  dropped: '搁置',
};

export function TextLibrary({ onOpenText, onStateChange }: Props) {
  // 筛选与页码住在 URL 里：可收藏、可分享，后退能回到上一页
  const route = useRoute();
  const filter = (route.params.get('filter') ?? 'all') as Filter;
  const page = Math.max(1, Number(route.params.get('page')) || 1);
  const offset = (page - 1) * PAGE;

  const [items, setItems] = useState<TextListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, reading: 0, done: 0, unread: 0 });
  const [error, setError] = useState<string | null>(null);
  /**
   * 数据版本号：只在新数据到位时 +1，用它作列表的 key 来重播进场动画。
   *
   * 不能拿筛选条件／页码当 key —— 那样点下去的一瞬间就重挂载了，
   * 动画播在旧数据上，真正的新内容反而是静默替换的。
   */
  const [gen, setGen] = useState(0);
  /**
   * 加载状态从参数派生，而不是在 effect 里 setLoading(true)。
   *
   * 后者晚一帧：点下去那次渲染里 loading 还是 false，会把旧数据先画一帧
   * （useEffect 在浏览器绘制之后才跑），看上去就是「闪一下旧内容再转圈」。
   * 派生的话，参数一变就立刻是 loading。
   */
  const paramsKey = `${filter}|${offset}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // 本地查询常在 100ms 内返回 —— 直接显示只会闪一下，延迟到真的等久了再显示
  const loading = useDelayedFlag(loadedKey !== paramsKey);

  const load = useCallback(async () => {
    try {
      const r = await api.texts({ filter, offset, limit: PAGE });
      setItems(r.items);
      setTotal(r.total);
      setCounts(r.counts);
      setError(null);
      setGen((g) => g + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // 失败也算这次请求结束了，不然加载动画会一直转
      setLoadedKey(paramsKey);
    }
  }, [filter, offset, paramsKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = (f: Filter) => {
    setParams({ filter: f === 'all' ? undefined : f, page: undefined });
  };

  const goPage = (nextOffset: number) => {
    const p = Math.floor(nextOffset / PAGE) + 1;
    setParams({ page: p === 1 ? undefined : p });
  };

  return (
    <div className="wrap">
      <div className="page">
        <div className="toolbar">
          <h2 className="page-title">文本库</h2>
          <div className="chips">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`chip${filter === f.key ? ' on' : ''}`}
                onClick={() => pick(f.key)}
              >
                {f.label}
                <span className="chip-n">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <button className="btn btn-xs push-right" onClick={() => void load().then(onStateChange)}>
            刷新
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {/* 换筛选 / 翻页时用加载动画占位 —— 全局统一这一个指示器 */}
        {loading && (
          <div className="loading">
            <Spinner />
          </div>
        )}

        {!loading && items && items.length === 0 && <p className="empty">没有文本</p>}

        {!loading && items && items.length > 0 && (
          /* key 用数据版本号：新数据到位才重播进场动画 */
          <ul className="textlist list-anim" key={gen}>
            {items.map((t) => (
              <li key={t.id} className="textrow" onClick={() => onOpenText(t.id)}>
                <div className="textrow-head">
                  <span className={`pill ${t.category}`}>
                    {CATEGORY_LABEL[t.category] ?? t.category}
                  </span>
                  <span className="textrow-src">{t.source}</span>
                  {t.status && (
                    <span className={`pill ${t.status === 'done' ? 'done' : 'reading'}`}>
                      {STATUS_LABEL[t.status] ?? t.status}
                    </span>
                  )}
                  <span className="textrow-time">
                    {t.started_at ? fmt(t.started_at) : '未读'}
                    {t.finished_at && ` → ${fmt(t.finished_at)}`}
                  </span>
                </div>

                <div className="textrow-title">{t.title ?? '无标题'}</div>

                <div className="textrow-meta">
                  <span>{t.word_count} 词</span>
                  <span>均 L{t.avg_level.toFixed(1)}</span>
                  {t.status === 'done' && <span>标记 {t.n_marked ?? 0}</span>}
                  {t.times_read > 1 && <span>读过 {t.times_read} 次</span>}
                </div>
              </li>
            ))}
          </ul>
        )}

        {!loading && (
          <Pager total={total} offset={offset} limit={PAGE} onChange={goPage} />
        )}
      </div>
    </div>
  );
}

/** 相对时间：同一天只显示时分，更早显示月日。 */
function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}
