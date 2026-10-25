import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AppState, GradeKey, ReviewItem, ReviewPlan, WordDetail, WordRequest } from '../types';
import { Spinner } from './Spinner';
import { WordCard } from './WordCard';

interface Props {
  state: AppState;
  onStateChange: () => void | Promise<void>;
}

/**
 * 一道题的阶段。
 *
 * 两种题型，对应两个方向的能力，缺一不算过：
 *   recognize —— 认读（英 → 中）：只给英文，判断认不认识。新词先走这一步。
 *   cloze     —— 默写（中 → 英）：给挖空的句子 + 中文释义，把词写出来。
 *
 * 认读通过后 verified 仍是 0，下一步才是默写；默写成功才 verified = 1。
 * 所以「两个都会才算过」不是额外加的规则 —— 它就是这套状态机本身。
 */
type Phase =
  /** 认读：只给英文 */
  | 'recognize'
  /** 默写：挖空句 + 中文释义 */
  | 'cloze'
  /** 默写已揭示，等自评 */
  | 'revealed'
  /** 评完熟练度 —— 亮出这个词的卡片，看完自己确认再进下一个 */
  | 'card';

const CLOZE_GRADES: { key: GradeKey; label: string; cls: string; k: string }[] = [
  { key: 'cloze_good', label: '想起来了', cls: 'good', k: '1' },
  { key: 'cloze_fuzzy', label: '有点模糊', cls: '', k: '2' },
  { key: 'cloze_fail', label: '没想起来', cls: 'bad', k: '3' },
];

const RECOGNIZE_GRADES: { key: GradeKey; label: string; cls: string; k: string }[] = [
  { key: 'reading_good', label: '认识', cls: 'good', k: '1' },
  { key: 'reading_fail', label: '不认识', cls: 'bad', k: '2' },
];

/** 题目该从哪个阶段开始 —— 由服务端给的 test 决定。 */
const startPhase = (item: ReviewItem | undefined): Phase =>
  item?.test === 'recognize' ? 'recognize' : 'cloze';

export function ReviewSession({ state, onStateChange }: Props) {
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>('cloze');
  const [typed, setTyped] = useState('');
  /** 评完熟练度后展示的单词卡片 */
  const [cardDetail, setCardDetail] = useState<WordDetail | null>(null);
  const [cardLoading, setCardLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setIdx(0);
    setTyped('');
    setCardDetail(null);
    try {
      const p = await api.reviewPlan(12);
      setPlan(p);
      setPhase(startPhase(p.items[0]));
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

  /**
   * 评分。注意这里**不**推进到下一题 —— 先把这个词的卡片亮出来，
   * 让用户看完确认（直接翻页会把还没看清的词冲走）。
   */
  const submit = useCallback(
    (grade: GradeKey) => {
      if (!item) return;
      setLoading(true);
      setCardLoading(true);
      api
        .grade({
          word: item.word,
          textId: item.textId,
          sentenceId: item.sentenceId,
          grade,
          typed,
        })
        .then(async () => {
          setCardDetail(await api.word(item.word, item.level));
          setPhase('card');
          void onStateChange();
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          setLoading(false);
          setCardLoading(false);
        });
    },
    [item, typed, onStateChange],
  );

  /** 确认看完 → 进下一个词（并按下个词的题型决定从哪一步开始） */
  const next = useCallback(() => {
    const nxt = plan?.items[idx + 1];
    setIdx((i) => i + 1);
    setPhase(startPhase(nxt));
    setTyped('');
    setCardDetail(null);
    setError(null);
  }, [plan, idx]);

  /** 卡片上标记 / 取消标记 */
  const setMark = useCallback(
    async (want: boolean) => {
      if (!item) return;
      try {
        if (want) {
          // 出处用复习时这条语境所在的文章与句子
          await api.mark(item.word, { textId: item.textId, sentenceId: item.sentenceId });
        } else await api.unmark(item.word);
        setCardDetail(await api.word(item.word, item.level));
        void onStateChange();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [item, onStateChange],
  );

  /**
   * 点例句里的词 → 就地换成那个词的卡片。
   * 侧边栏能做到的事这里也要能做，否则同一张卡在两边手感不同。
   * 只换卡片，不动 idx —— 「下一个」仍然推进这道题。
   */
  const openOtherWord = useCallback(async (r: WordRequest) => {
    setCardLoading(true);
    try {
      setCardDetail(await api.word(r.word, r.level));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCardLoading(false);
    }
  }, []);

  // 键盘：认读 1/2，默写 Enter 揭示、揭示后 1/2/3 自评，卡片页 Enter 进下一个
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!item || loading) return;
      if (phase === 'card') {
        if (e.key === 'Enter') {
          e.preventDefault();
          next();
        }
        return;
      }
      if (phase === 'recognize' || phase === 'revealed') {
        const grades = phase === 'recognize' ? RECOGNIZE_GRADES : CLOZE_GRADES;
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
  }, [item, phase, loading, submit, next]);

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
            <h2 className="section-title">没有到期的词</h2>
            <button className="btn primary" type="button" onClick={() => void load()}>
              重新检查
            </button>
          </div>
        )}

        {plan && plan.dueCount > 0 && plan.items.length === 0 && (
          <div className="section">
            <h2 className="section-title">语料库里没有这些词</h2>
            <p className="desc">
              到期 {plan.dueCount} / 语料 {state.corpus.texts} 篇
            </p>
            <button className="btn primary" type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {/* 完成页不再重复词数 —— 标题上已经有了 */}
        {plan && plan.items.length > 0 && !item && (
          <div className="section">
            <h2 className="section-title">复习完成</h2>
            <button className="btn primary" type="button" onClick={() => void load()}>
              再来一轮
            </button>
          </div>
        )}

        {plan && item && (
          <>
            {phase === 'card' ? (
              <>
                <h2 className="review-title">
                  复习 <span className="muted">{plan.items.length}</span>
                </h2>

                {/*
                  卡片摆在题面**后面**，两者同屏 ——
                  光看释义记不住，得能一边看它长什么样，一边看它是什么意思。
                */}
                <div className="qcard">
                  <SentenceLine item={item} />
                </div>

                <div className="section">
                  <WordCard
                    detail={cardDetail}
                    loading={cardLoading}
                    marked={Boolean(cardDetail?.card)}
                    onOpenWord={(r) => void openOtherWord(r)}
                    onMark={() => void setMark(true)}
                    onUnmark={() => void setMark(false)}
                  />
                </div>

                <div className="btn-row">
                  <button className="btn primary wide" type="button" onClick={next}>
                    {idx + 1 < plan.items.length ? '下一个' : '完成本轮'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="review-title review-title-top">
                  复习 <span className="muted">{plan.items.length}</span>
                </h2>

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
                    <span className="pill">{item.test === 'recognize' ? '认读' : '默写'}</span>
                  </div>

                  {item.reusedContext && <div className="pill">沿用原文</div>}

                  {phase === 'recognize' ? (
                    <>
                      {/* 认读只给英文 —— 不给音标、不给句子，否则等于直接告诉意思 */}
                      <div className="q-word">{item.answer}</div>
                      <div className="grade-row">
                        {RECOGNIZE_GRADES.map((g) => (
                          <button
                            key={g.key}
                            className={`grade-btn ${g.cls}`}
                            type="button"
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
                        {phase === 'cloze'
                          ? renderBlanked(item.blanked)
                          : renderRevealed(item.sentence, item.answer)}
                      </div>

                      {/*
                        默写给中文释义 —— 这是这一版最重要的放松：
                        原来只有挖空的句子，等于要求「从语境推词形」，
                        现在告诉你它在中文里是什么意思，只考拼写与回忆。
                        揭示之后就把中文收起来，免得和答案摆在一起像在提示。
                      */}
                      {phase === 'cloze' && <p className="q-zh">{firstLine(item.translation)}</p>}

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
                          <div className="btn-row">
                            <button
                              className="btn primary"
                              type="button"
                              onClick={() => setPhase('revealed')}
                            >
                              对答案
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          {/*
                            揭示区只回答一件事：对不对。
                            音标、等级、中文释义一概不放 —— 那些属于评分之后亮出来的词卡。
                          */}
                          <div className="q-answer-line">
                            <b>{item.answer}</b>
                            {showIncorrect(typed, item.answer) && (
                              <>
                                <span className="ans-sep">/</span>
                                <span className="ans-typed">{typed.trim()}</span>
                              </>
                            )}
                          </div>
                          <div className="grade-row">
                            {CLOZE_GRADES.map((g) => (
                              <button
                                key={g.key}
                                className={`grade-btn ${g.cls}`}
                                type="button"
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
          </>
        )}
      </div>
    </div>
  );
}

/** 释义只取第一行 —— 后面的「[医]」这类分科释义在提示位置太吵。 */
function firstLine(translation: string | null): string {
  return (translation ?? '').split('\\n').filter(Boolean)[0] ?? '';
}

/**
 * 卡片页上方的题面：把词放回原句里，高亮它。
 *
 * 定题的时候只给一段句子是不行的（那等于把答案写出来了），
 * 所以只用在评分之后的卡片页 —— 上面是它在原文里的样子，下面是释义。
 */
function SentenceLine({ item }: { item: ReviewItem }) {
  return <div className="q-sentence">{renderRevealed(item.sentence, item.answer)}</div>;
}

/**
 * 只在拼错时才把用户填的也摆出来。
 *
 * 这里的字符串比对**仅仅是为了决定要不要多写一个词**，评分仍然是用户自己选的
 * （大小写与首尾空白不算错，因为考的是记不记得住这个词，不是打字）。
 */
function showIncorrect(typed: string, answer: string): boolean {
  const t = typed.trim().toLowerCase();
  return t.length > 0 && t !== answer.toLowerCase();
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
