import { useMemo } from 'react';
import type { Segment } from '../types';

interface Props {
  segments: Segment[];
  marked: Set<string>;
  showLevels: boolean;
  onWord: (word: string, level: number, surface: string) => void;
}

/** 按空行把片段序列切成段落，供 <p> 渲染。 */
function toParagraphs(segments: Segment[]): Segment[][] {
  const paras: Segment[][] = [];
  let cur: Segment[] = [];

  for (const seg of segments) {
    if (seg.kind !== 'other') {
      cur.push(seg);
      continue;
    }
    const parts = seg.text.split(/\n{2,}/);
    parts.forEach((part, i) => {
      if (i > 0) {
        paras.push(cur);
        cur = [];
      }
      if (part) cur.push({ ...seg, text: part });
    });
  }
  if (cur.length > 0) paras.push(cur);
  return paras.filter((p) => p.some((s) => s.kind === 'word' || s.text.trim()));
}

/**
 * 正文渲染：每个词是一个可点的 span，颜色表示难度、下划线表示已标记。
 *
 * 从 Reader 里拆出来 —— 分词到段落的还原逻辑与阅读会话的其他职责无关，
 * 混在一起会让 Reader 变成一坨。
 */
export function TextBody({ segments, marked, showLevels, onWord }: Props) {
  const paragraphs = useMemo(() => toParagraphs(segments), [segments]);

  return (
    <article className={`prose${showLevels ? ' show-levels' : ''}`}>
      {paragraphs.map((para, pi) => (
        <p key={pi}>
          {para.map((seg, si) => {
            if (seg.kind !== 'word') return <span key={si}>{seg.text}</span>;
            const word = seg.word ?? seg.text.toLowerCase();
            const cls = ['w', `lv${seg.level ?? 1}`, marked.has(word) ? 'marked' : '']
              .filter(Boolean)
              .join(' ');
            return (
              <span key={si} className={cls} onClick={() => onWord(word, seg.level ?? 1, seg.text)}>
                {seg.text}
              </span>
            );
          })}
        </p>
      ))}
    </article>
  );
}
