import { useCallback, useEffect, useRef, useState } from 'react';
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

  /**
   * 本篇标记的词，摊在正文下面。
   *
   * 不再是「读完」后的一次性快照 —— 标一个就多一行，取消就少一行，
   * 不用先点「读完」再切一屏去看。
   */
  const [rows, setRows] = useState<WordRow[]>([]);
  const rowsReq = useRef(0);

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

  /**
   * 下一篇 = 把这一篇收尾 + 取新的。
   *
   * 收尾（写 read_done 流水、关掉会话、累加读过次数）以前是「读完」按钮的职责，
   * 现在合进这一步 —— 用户少一次点击，记录不会因此少一条。
   */
  const nextText = useCallback(async () => {
    if (text) {
      try {
        await api.finish(text.id, payload?.session.id);
      } catch {
        /* 收尾失败不该挡住往下读 */
      }
    }
    await load('next');
  }, [text, payload, load]);

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

  /**
   * 标记一变就重新拉一次本篇的标记词。
   *
   * marked 是 App 托管的 Set，标记/取消都会换掉它 —— 拿它当依赖即可，
   * 不需要另外的失效通知。
   */
  useEffect(() => {
    if (!text) return;
    const id = ++rowsReq.current;
    void api
      .markedOfText(text.id)
      .then((r) => {
        // 连点或切文章时只认最后一次
        if (rowsReq.current === id) setRows(r.rows);
      })
      .catch(() => {
        /* 列表拉不到不影响阅读 */
      });
  }, [text, marked]);

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

            {/*
              标记的词就摊在正文下面，随标记实时变 ——
              不必先点「读完」切一屏、再回头对照。
              「下一篇」直接可点，它负责把这一篇收尾（记进流水、关掉会话）再取新的。
            */}
            <MarkedSummary rows={rows} onOpenWord={onOpenWord} onNext={() => void nextText()} />
          </>
        )}
      </div>
    </div>
  );
}
