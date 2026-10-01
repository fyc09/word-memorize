import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { levelVar } from '../types';
import type { AppState, LearnPayload, MarkedEntry, Segment, TextMeta, WordRequest } from '../types';
import { TextBody } from './TextBody';
import { MarkedSummary } from './MarkedSummary';

interface Props {
  state: AppState;
  onStateChange: () => void | Promise<void>;
  onOpenWord: (r: WordRequest) => void | Promise<void>;
  /** 标记成功后告知外层，让开着的词卡也同步成「已标记」 */
  onMarked?: (word: string) => void | Promise<void>;
}

type Payload = LearnPayload & { text: TextMeta & { segments: Segment[] } };

export function Reader({ state, onStateChange, onOpenWord, onMarked }: Props) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [showLevels, setShowLevels] = useState(true);
  const [clickToMark, setClickToMark] = useState(false);
  const [summary, setSummary] = useState<MarkedEntry[] | null>(null);

  /**
   * 本篇是不是「上次没读完，这次接着读」。
   * 不能直接看 session.status —— 刚开的新会话也是 'reading'，
   * 那样一进页面就会错标成「续读」。
   */
  const [resumed, setResumed] = useState(false);

  const text = payload?.text ?? null;

  /** 载入：先看有没有没读完的，没有才取新的。 */
  const load = useCallback(
    async (mode: 'resume' | 'next') => {
      setLoading(true);
      setError(null);
      setNotice(null);
      setSummary(null);
      try {
        if (mode === 'resume') {
          const { payload: existing } = await api.current();
          if (existing) {
            setPayload(existing as Payload);
            setMarked(new Set(existing.markedWords));
            setResumed(true);
            return;
          }
        }
        const res = await api.learnNext();
        if (!res.payload) {
          setPayload(null);
          setNotice(res.reason ?? '没有合适的文本');
          return;
        }
        setPayload(res.payload as Payload);
        setMarked(new Set(res.payload.markedWords));
        setResumed(false);
        void onStateChange();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [onStateChange],
  );

  useEffect(() => {
    void load('resume');
    // 只在挂载时跑一次；切回本页签会重新挂载，届时自然走续读逻辑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mark = useCallback(
    async (word: string, textId: number) => {
      setMarked((prev) => new Set(prev).add(word));
      try {
        await api.mark(word, textId);
        void onMarked?.(word);
        void onStateChange();
      } catch (e) {
        setMarked((prev) => {
          const next = new Set(prev);
          next.delete(word);
          return next;
        });
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onStateChange, onMarked],
  );

  const finish = useCallback(async () => {
    if (!text) return;
    try {
      const res = await api.finish(text.id, payload?.session.id);
      setSummary(res.marked);
      void onStateChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [text, payload, onStateChange]);

  /** 点正文里的词：开了「点击即标记」就先标记，然后总是打开释义面板。 */
  const handleWord = useCallback(
    (word: string, level: number, _surface: string) => {
      if (!text) return;
      if (clickToMark && level >= 2 && !marked.has(word)) void mark(word, text.id);
      void onOpenWord({ word, level, textId: text.id });
    },
    [text, clickToMark, marked, mark, onOpenWord],
  );

  const legendLevels = state.levels.filter((l) => l.level > 0);

  return (
    <div className="reader-wrap">
      <div className="reader">
        {error && <div className="error">{error}</div>}

        {loading && (
          <div className="loading">
            <div className="spinner" />
            载入中…
          </div>
        )}

        {!loading && !text && (
          <div className="empty">
            <p>{notice ?? '暂无文本'}</p>
            <button className="btn primary" onClick={() => void load('next')}>
              取一篇
            </button>
          </div>
        )}

        {!loading && text && (
          <>
            <div className="text-head">
              <div className="text-source">
                <span className={`pill ${text.category}`}>
                  {state.categoriesMeta[text.category]?.name ?? text.category}
                </span>
                <span>{text.source}</span>
                <span className="sep">{text.word_count} 词</span>
                {text.unknownCount !== undefined && text.unknownRate !== undefined && (
                  <span className="sep">
                    {text.unknownCount} 个生词 {(text.unknownRate * 100).toFixed(1)}%
                  </span>
                )}
                {resumed && <span className="pill reading">续读</span>}
              </div>
              <h1 className="text-title">{text.title ?? '无标题'}</h1>
              {text.url && (
                <div className="text-meta">
                  <a href={text.url} target="_blank" rel="noreferrer">
                    原文
                  </a>
                  {text.published && <span>{text.published.slice(0, 16)}</span>}
                </div>
              )}
            </div>

            {summary !== null ? (
              <MarkedSummary
                entries={summary}
                textId={text.id}
                onOpenWord={onOpenWord}
                onNext={() => void load('next')}
              />
            ) : (
              <>
                <div className="toolbar">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={showLevels}
                      onChange={(e) => setShowLevels(e.target.checked)}
                    />
                    显示难度
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={clickToMark}
                      onChange={(e) => setClickToMark(e.target.checked)}
                    />
                    点击即标记
                  </label>
                  <div className="legend">
                    {legendLevels.map((l) => (
                      <span key={l.level} className="legend-item" style={{ color: levelVar(l.level) }}>
                        {l.name}
                      </span>
                    ))}
                  </div>
                  <div className="push-right">
                    <button className="btn" onClick={() => void load('next')}>
                      换一篇
                    </button>
                  </div>
                </div>

                {notice && <div className="notice">{notice}</div>}

                <TextBody
                  segments={text.segments}
                  marked={marked}
                  showLevels={showLevels}
                  onWord={handleWord}
                />

                <div className="toolbar toolbar-end">
                  <button className="btn primary" onClick={() => void finish()}>
                    读完
                  </button>
                  <span className="muted">{marked.size} 个生词</span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
