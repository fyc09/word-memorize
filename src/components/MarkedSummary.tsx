import type { WordRequest, WordRow } from '../types';
import { WordTable } from './WordTable';

interface Props {
  rows: WordRow[];
  onOpenWord: (r: WordRequest) => void | Promise<void>;
  onNext: () => void;
}

/**
 * 读完一篇后，接在文章下面的「本篇标记词」。
 *
 * 不再单独占一屏：用户刚读完，正要回头确认这些词的意思，
 * 文章留在上面才看得出它们的语境 —— 把正文撤掉等于把他刚读的东西收走。
 *
 * 词表用和单词本同一个组件（WordTable），列、行、点法完全一致；
 * 数据也由服务端按同一个形状给（toWordRow），前端不必再造一个。
 */
export function MarkedSummary({ rows, onOpenWord, onNext }: Props) {
  return (
    <section className="section">
      <div className="toolbar">
        <h2 className="section-title">标记的词</h2>
        <span className="muted">{rows.length}</span>
        <div className="push-right">
          <button className="btn primary" onClick={onNext}>
            下一篇
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="empty">本篇没有标记生词</p>
      ) : (
        <WordTable rows={rows} onOpenWord={onOpenWord} />
      )}
    </section>
  );
}
