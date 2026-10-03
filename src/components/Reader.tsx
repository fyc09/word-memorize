import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AppState, LearnPayload, Segment, TextMeta, WordRequest, WordRow } from '../types';
import { TextBody } from './TextBody';
import { MarkedSummary } from './MarkedSummary';
import { Spinner } from './Spinner';

interface Props {
  state: AppState;
  /** 当前这篇里已标记的词。上面 App 托管，因为词卡里标记也要立刻反映到正文下划线 */
  marked: Set<string>;
  onMarkedWords: (words: string[]) => void;
  onStateChange: () => void | Promise<void>;
  onOpenWord: (r: WordRequest) => void | Promise<void>;
}

type Payload = LearnPayload & { text: TextMeta & { segments: Segment[] } };

export function Reader({ state, marked, onMarkedWords, onStateChange, onOpenWord }: Props) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<WordRow[] | null>(null);

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
            onMarkedWords(existing.markedWords);
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
        onMarkedWords(res.payload.markedWords);
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

  /**
   * 点正文里的词 → 打开词卡。标记靠词卡里的按钮，不再「点击即标记」。
   * 带上 text.id 作为出处 —— 在这篇里遇到它，也是在这篇里标的。
   */
  const handleWord = useCallback(
    (word: string, level: number) => {
      if (!text) return;
      void onOpenWord({ word, level, origin: { textId: text.id } });
    },
    [text, onOpenWord],
  );

  return (
    <div className="reader-wrap">
      <div className="reader">
        {error && <div className="error">{error}</div>}

        {loading && (
          <div className="loading">
            <Spinner />
            载入中…
          </div>
        )}

        {!loading && !text && (
          <div className="empty">
            <p>{notice ?? '暂无文本'}</p>
            <button className="btn primary" type="button" onClick={() => void load('next')}>
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

            <div className="toolbar">
              <div className="push-right">
                <button className="btn" type="button" onClick={() => void load('next')}>
                  换一篇
                </button>
              </div>
            </div>

            <TextBody
              segments={text.segments}
              marked={marked}
              onWord={handleWord}
              boilerplateFrom={text.boilerplateFrom}
            />

            {summary === null ? (
              <div className="toolbar toolbar-end">
                <button className="btn primary" type="button" onClick={() => void finish()}>
                  读完
                </button>
                {/* 不写「N 个生词」—— 顶上那一栏已经用了「生词」表示
                    「超出你水平的词」，同一个词两个含义会很混 */}
                <span className="muted">已标记 {marked.size}</span>
              </div>
            ) : (
              /* 摘要接在正文**下面**，不替掉正文 —— 刚读完正要回头对照，
                 文章留着才看得出这些词的语境 */
              <MarkedSummary
                rows={summary}
                onOpenWord={onOpenWord}
                onNext={() => void load('next')}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
