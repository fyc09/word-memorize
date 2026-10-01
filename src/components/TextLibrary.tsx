import { useCallback, useEffect, useState } from 'react';
import { api, PAGE } from '../api';
import type { TextListItem } from '../types';
import { Pager } from './Pager';

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
  const [filter, setFilter] = useState<Filter>('all');
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<TextListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, reading: 0, done: 0, unread: 0 });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.texts({ filter, offset, limit: PAGE });
      setItems(r.items);
      setTotal(r.total);
      setCounts(r.counts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filter, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = (f: Filter) => {
    setFilter(f);
    setOffset(0);
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

        {!items && (
          <div className="loading">
            <div className="spinner" />
            载入中…
          </div>
        )}

        {items && items.length === 0 && <p className="empty">没有文本</p>}

        {items && items.length > 0 && (
          <ul className="textlist">
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

        <Pager total={total} offset={offset} limit={PAGE} onChange={setOffset} />
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
