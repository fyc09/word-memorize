import { levelVar } from '../types';
import type { WordRequest, WordRow } from '../types';

interface Props {
  rows: WordRow[];
  onOpenWord: (r: WordRequest) => void | Promise<void>;
}

/** 阶段标签的配色。和单词本一致，所以放在这里而不是各页面自己定义。 */
const STAGE_CLS: Record<string, string> = {
  new: 'pill',
  reading: 'pill reading',
  learning: 'pill science',
  mature: 'pill academic',
};

/**
 * 词表。
 *
 * 单词本（整库）和「读完一篇」的标记词列表共用这一个 —— 两处列一样、行一样、
 * 点法一样，各写一份迟早会漂（摘要页原本就是自己一套 def-row，
 * 结果同一个词在两个页面长得完全不同）。
 */
export function WordTable({ rows, onOpenWord }: Props) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>单词</th>
          <th>释义</th>
          <th>阶段</th>
          <th>复习</th>
          <th>下次</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((w) => (
          <tr
            key={w.word}
            className="dict-row"
            onClick={() => void onOpenWord({ word: w.word, level: w.level })}
          >
            <td className="word-cell" style={{ color: levelVar(w.level) }}>
              {w.word}
            </td>
            <td className="trans-cell">
              {(w.translation ?? '').split('\\n')[0].slice(0, 90) || '—'}
            </td>
            <td>
              {/* 没学过就没有阶段可言 —— 写「无数据」而不是留白，
                  否则会让人以为是加载失败 */}
              {w.studied ? (
                <span className={STAGE_CLS[w.stage] ?? 'pill'}>{w.stageName}</span>
              ) : (
                <span className="muted">无数据</span>
              )}
            </td>
            {w.studied ? (
              <>
                <td className="num-cell">
                  {w.reps}
                  {(w.lapses ?? 0) > 0 && <span className="muted"> / 忘 {w.lapses}</span>}
                </td>
                <td className="muted">{dueLabel(w)}</td>
              </>
            ) : (
              <>
                <td />
                <td />
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 距下次复习还有多久。已到期就说「到期」，不要显示负数。 */
export function dueLabel(w: WordRow): string {
  if (!w.due_at) return '—';
  const diff = new Date(w.due_at).getTime() - Date.now();
  if (diff <= 0) return '到期';
  const days = diff / 86400000;
  if (days < 1) return `${Math.round(days * 24)} 小时后`;
  return `${days.toFixed(days < 3 ? 1 : 0)} 天后`;
}
