import { levelVar } from '../types';
import type { WordDetail } from '../types';
import { ActivityLog } from './ActivityLog';

/** 把句子高亮出目标词，用于「显示正确答案」这一步。 */
function highlightAnswer(sentence: string, answer: string): React.ReactNode {
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

interface Props {
  detail: WordDetail | null;
  loading: boolean;
  marked: boolean;
  /** 从文本面板里点进来时，给出「返回文章」的入口 */
  backLabel?: string;
  onBack?: () => void;
  onMark: () => void;
  onUnmark: () => void;
  onClose: () => void;
}

export function WordCard({ detail, loading, marked, backLabel, onBack, onMark, onUnmark, onClose }: Props) {
  if (loading) {
    return (
      <aside className="side">
        <div className="loading">
          <div className="spinner" />
          查询中…
        </div>
      </aside>
    );
  }

  // 没选中单词时整个侧栏不渲染，正文占满宽度 ——
  // 比放一段「点击正文中的任意单词查看释义」的解释文字更有用。
  if (!detail) return null;

  return (
    <aside className="side">
      {onBack && (
        <button className="backlink" onClick={onBack}>
          ← {backLabel ?? '返回'}
        </button>
      )}

      <div className="side-head">
        <div className="side-head-main">
          <h2 className="card-word">{detail.word}</h2>
          <div className="card-sub">
            <span className="lv-badge" style={{ background: levelVar(detail.level) }}>
              {detail.levelName}
            </span>
            {detail.phonetic && <span>/{detail.phonetic}/</span>}
            {detail.pos && <span>{detail.pos}</span>}
          </div>
        </div>
        <button className="btn btn-xs" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      {detail.tags.length > 0 && (
        <div className="card-section">
          <h3>考纲</h3>
          <div className="variants">
            {detail.tags.map((t) => (
              <span key={t} className="variant">
                {t.toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/*
        释义不给标题 —— 它下面就是中文释义，标题没有信息增量；
        而它本来就是这张卡的主内容，紧跟词头反而更直接。
        保留标题的只有真正需要解码的几组：考纲、词形变化、真实例句。
      */}
      <div className="def card-lead">
        {detail.found ? renderDefinition(detail.translation) : <span className="q-hint">词库未收录</span>}
      </div>

      {detail.found && detail.definition && (
        <div className="def def-en card-section">{renderDefinition(detail.definition)}</div>
      )}

      {detail.variants.length > 0 && (
        <div className="card-section">
          <h3>词形变化</h3>
          <div className="variants">
            {detail.variants.map((v, i) => (
              <span key={`${v.form}-${i}`} className="variant">
                <em>{v.label}</em>
                {v.form}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card-section">
        <h3>真实例句{detail.examples.length > 0 && ` (${detail.examples.length})`}</h3>
        {detail.examples.length === 0 ? (
          <p className="q-hint">—</p>
        ) : (
          detail.examples.map((ex) => (
            <div key={ex.sentenceId} className="example">
              {highlightAnswer(ex.sentence, detail.word)}
              <span className="example-src">
                {ex.source} / {ex.title?.slice(0, 48) ?? '无标题'}
              </span>
            </div>
          ))
        )}
      </div>

      {detail.card && (
        <div className="card-section">
          <div className="variants">
            <span className="variant">
              <em>阶段</em>
              {detail.card.stageName}
            </span>
            <span className="variant">
              <em>复习</em>
              {detail.card.reps}
            </span>
            <span className="variant">
              <em>间隔</em>
              {detail.card.interval_days.toFixed(1)} 天
            </span>
            <span className="variant">
              <em>遗忘</em>
              {detail.card.lapses}
            </span>
          </div>
          {detail.card.verified === 0 && detail.card.reps > 0 && (
            <div className="notice warn mt-10">待验证</div>
          )}
        </div>
      )}

      {/*
        这个词的 append-only 记录。
        和文本库里的「记录」是同一份流水，只是这里按词筛。
      */}
      {detail.history.length > 0 && (
        <div className="card-section">
          <h3>记录 ({detail.history.length})</h3>
          <ActivityLog items={detail.history} showWord={false} />
        </div>
      )}

      <div className="btn-row">
        {marked ? (
          <button className="btn danger wide" onClick={onUnmark}>
            取消标记
          </button>
        ) : (
          <button className="btn primary wide" onClick={onMark}>
            标记为生词
          </button>
        )}
      </div>
    </aside>
  );
}

/** 把 ECDICT 的释义文本按词性切分成带样式的片段。 */
function renderDefinition(translation: string | null): React.ReactNode {
  if (!translation) return '（无中文释义）';
  const parts = translation.split('\\n').filter(Boolean);
  return parts.map((line, i) => {
    const m = line.match(/^([a-z]+\.)\s*(.*)$/i);
    if (!m) return <div key={i}>{line}</div>;
    return (
      <div key={i}>
        <span className="def-part">{m[1]}</span> {m[2]}
      </div>
    );
  });
}
