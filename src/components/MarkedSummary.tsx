import { levelVar } from '../types';
import type { MarkedEntry, WordRequest } from '../types';

interface Props {
  entries: MarkedEntry[];
  onOpenWord: (r: WordRequest) => void | Promise<void>;
  onNext: () => void;
}

/**
 * 读完一篇后给出的「本篇标记词释义」面板。
 *
 * 用户刚读完，正是需要回头确认这些词含义的时候 ——
 * 所以这里直接把释义摊开，而不是让他再逐个点开。
 */
export function MarkedSummary({ entries, onOpenWord, onNext }: Props) {
  return (
    <section className="panel">
      <div className="toolbar">
        <h2 className="page-title">标记的词</h2>
        <span className="muted">{entries.length}</span>
        <div className="push-right">
          <button className="btn primary" onClick={onNext}>
            下一篇
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="empty">本篇没有标记生词</p>
      ) : (
        <ul className="defs">
          {entries.map((m) => (
            <li
              key={m.word}
              className="def-row"
              onClick={() => void onOpenWord({ word: m.word, level: m.level })}
            >
              <span className="def-word" style={{ color: levelVar(m.level) }}>
                {m.word}
              </span>
              {m.phonetic && <span className="def-phon">/{m.phonetic}/</span>}
              <span className="def-trans">
                {(m.translation ?? '').split('\\n')[0].slice(0, 120)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
