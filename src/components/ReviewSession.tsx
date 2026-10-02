import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AppState, GradeKey, ReviewItem, ReviewPlan } from '../types';
import { Spinner } from './Spinner';

interface Props {
  state: AppState;
  onStateChange: () => void | Promise<void>;
}

/** 一道题的阶段。 */
type Phase =
  /** 看挖空的句子，回忆并默写 */
  | 'cloze'
  /** 已揭示答案，等用户自评 */
  | 'revealed'
  /** 「填不出来」后的退回方式：把词放回原句里读，只判断认不认识 */
  | 'reading';

const CLOZE_GRADES: { key: GradeKey; label: string; cls: string; k: string }[] = [
  { key: 'cloze_good', label: '想起来了', cls: 'good', k: '1' },
  { key: 'cloze_fuzzy', label: '有点模糊', cls: '', k: '2' },
  { key: 'cloze_fail', label: '没想起来', cls: 'bad', k: '3' },
];

const READING_GRADES: { key: GradeKey; label: string; cls: string; k: string }[] = [
  { key: 'reading_good', label: '认识', cls: 'good', k: '1' },
  { key: 'reading_fail', label: '不认识', cls: 'bad', k: '2' },
];

export function ReviewSession({ state, onStateChange }: Props) {
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>('cloze');
  const [typed, setTyped] = useState('');
  // 是否主动要过提示。回忆阶段默认不给任何线索，
  // 因为音标一显示就等于把答案读出来了。
  const [usedHint, setUsedHint] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setIdx(0);
    setPhase('cloze');
    setTyped('');
    setUsedHint(false);
    try {
      setPlan(await api.reviewPlan(12));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const item: ReviewItem | undefined = plan?.items[idx];

  const submit = useCallback((grade: GradeKey) => {
    if (!item) return;
    setLoading(true);
    api
      .grade({ word: item.word, textId: item.textId, grade, typed, usedHint })
      .then(() => {
        setIdx((i) => i + 1);
        setPhase('cloze');
        setTyped('');
        setUsedHint(false);
        void onStateChange();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [item, typed, onStateChange]);

  // 键盘：1/2/3 评分，Enter 提交或揭示答案
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!item || loading) return;
      const grades = phase === 'reading' ? READING_GRADES : CLOZE_GRADES;
      if (phase === 'revealed' || phase === 'reading') {
        const g = grades.find((x) => x.k === e.key);
        if (g) {
          e.preventDefault();
          submit(g.key);
        }
      } else if (phase === 'cloze' && e.key === 'Enter') {
        e.preventDefault();
        setPhase('revealed');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, phase, loading, submit]);

  if (loading && !plan) {
    return (
      <div className="review-wrap">
        <div className="loading">
          <Spinner />
          准备中…
        </div>
      </div>
    );
  }

  return (
    <div className="review-wrap">
      <div className="review">
        {error && <div className="error">{error}</div>}

        {plan && plan.dueCount === 0 && (
          <div className="section">
            <h2>没有到期的词</h2>
            <button className="btn primary" onClick={() => void load()}>
              重新检查
            </button>
          </div>
        )}

        {plan && plan.dueCount > 0 && plan.items.length === 0 && (
          <div className="section">
            <h2>语料库里没有这些词</h2>
            <p className="desc">
              到期 {plan.dueCount} / 语料 {state.corpus.texts} 篇
            </p>
            <button className="btn primary" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {plan && plan.items.length > 0 && !item && (
          <div className="section">
            <h2>本轮完成</h2>
            <p className="desc">
              {plan.items.length} 词 / {plan.texts.length} 篇
            </p>
            <button className="btn primary" onClick={() => void load()}>
              再来一轮
            </button>
          </div>
        )}

        {plan && item && (
          <>
            <div className="plan-summary">
              <h2>
                本轮 {plan.items.length} 词 / {plan.texts.length} 篇
              </h2>
              <div className="plan-texts">
                {plan.texts.map((t) => (
                  <span key={t.id} className="plan-text">
                    覆盖 <b>{t.covers}</b> 词 / {t.source} / {t.word_count} 词
                    {t.reused && <span className="muted"> / 沿用原文</span>}
                  </span>
                ))}
              </div>
            </div>

            <div className="qcard" key={idx}>
              <div className="q-progress">
                <span>
                  {idx + 1} / {plan.items.length}
                </span>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${(idx / plan.items.length) * 100}%` }}
                  />
                </div>
                <span className={`pill ${item.stage === 'reading' ? '' : ''}`}>
                  {item.stage === 'reading' ? '待填空验证' : item.stage === 'new' ? '新词' : '巩固中'}
                </span>
              </div>

              {item.reusedContext && <div className="pill">沿用原文</div>}

              {phase === 'reading' ? (
                <>
                  <div className="ctx">{highlightContext(item.context, item.answer)}</div>
                  <div className="grade-row">
                    {READING_GRADES.map((g) => (
                      <button
                        key={g.key}
                        className={`grade-btn ${g.cls}`}
                        onClick={() => submit(g.key)}
                        disabled={loading}
                      >
                        <span className="k">{g.k}</span>
                        <b>{g.label}</b>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="q-sentence">
                    {phase === 'cloze' ? renderBlanked(item.blanked) : renderRevealed(item.sentence, item.answer)}
                  </div>

                  {phase === 'cloze' ? (
                    <>
                      <input
                        className="q-input"
                        value={typed}
                        autoFocus
                        placeholder="写出这个词"
                        onChange={(e) => setTyped(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            setPhase('revealed');
                          }
                        }}
                      />

                      {/*
                        回忆阶段刻意**不显示音标、词性、释义**。
                        念出 /ˈdekeɪd/ 基本等于把 decades 拼出来了，主动回忆就失效了。
                        想要线索必须主动点「给点提示」，而且只给词形，不给读音。
                      */}
                      {usedHint && (
                        <p className="q-hint">
                          共 <b>{item.answer.length}</b> 个字母 / 首字母 <b>{item.answer[0]}</b>
                          {item.pos ? <> / {item.pos}</> : null}
                        </p>
                      )}

                      <div className="btn-row">
                        <button className="btn primary" onClick={() => setPhase('revealed')}>
                          对答案
                        </button>
                        <button className="btn" onClick={() => setPhase('reading')}>
                          填不出来
                        </button>
                        <button
                          className="btn"
                          disabled={usedHint}
                          onClick={() => setUsedHint(true)}
                        >
                          {usedHint ? '已给提示' : '给点提示'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="q-answer-line">
                        正确答案：<b>{item.answer}</b>
                        {item.phonetic && <span className="muted"> /{item.phonetic}/</span>}
                        {item.pos && <span className="muted"> / {item.pos}</span>}
                        <span className="muted"> / L{item.level}</span>
                        {typed.trim() && (
                          <>
                            {' '}
                            <span className="muted">你写的是「{typed.trim()}」</span>
                          </>
                        )}
                        {usedHint && <span className="hint-used"> / 用过提示</span>}
                      </div>
                      {item.translation && (
                        <p className="q-hint">{item.translation.split('\\n')[0]}</p>
                      )}
                      <div className="grade-row">
                        {CLOZE_GRADES.map((g) => (
                          <button
                            key={g.key}
                            className={`grade-btn ${g.cls}`}
                            onClick={() => submit(g.key)}
                            disabled={loading}
                          >
                            <span className="k">{g.k}</span>
                            <b>{g.label}</b>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 挖空处渲染成下划线占位。 */
function renderBlanked(blanked: string) {
  const parts = blanked.split(/\u2007______\u2007|______/);
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && <span className="blank" />}
    </span>
  ));
}

/** 揭示答案：整句还原，正确词高亮。 */
function renderRevealed(sentence: string, answer: string) {
  const idx = sentence.toLowerCase().indexOf(answer.toLowerCase());
  if (idx < 0) return sentence;
  return (
    <>
      {sentence.slice(0, idx)}
      <span className="answer-reveal">{sentence.slice(idx, idx + answer.length)}</span>
      {sentence.slice(idx + answer.length)}
    </>
  );
}

/** 阅读模式下把目标词在上下文里高亮出来。 */
function highlightContext(context: string, answer: string) {
  if (!answer) return context;
  const lower = context.toLowerCase();
  const needle = answer.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;

  for (;;) {
    const found = lower.indexOf(needle, pos);
    if (found < 0) break;
    if (found > pos) nodes.push(context.slice(pos, found));
    nodes.push(
      <span key={key++} className="ctx-word">
        {context.slice(found, found + answer.length)}
      </span>,
    );
    pos = found + answer.length;
  }
  if (pos < context.length) nodes.push(context.slice(pos));
  return nodes;
}
