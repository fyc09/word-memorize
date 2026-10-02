import { useMemo } from 'react';
import type { Segment } from '../types';

interface SpanProps {
  segments: Segment[];
  marked: Set<string>;
  onWord: (word: string, level: number, surface: string) => void;
  /** 要突出的词（查词时让它从例句里跳出来），可选 */
  focus?: string | null;
  /** 尾部样板文字的起点，-1 或未传表示没有 */
  boilerplateFrom?: number;
}

/**
 * 把分词片段渲染成一串可点的词。
 *
 * 正文与例句共用这一个 —— 两处的「颜色=难度、下划线=已标记、点击=查词」
 * 必须完全一致，各写一份迟早会漂。
 */
export function WordSpans({ segments, marked, onWord, focus, boilerplateFrom = -1 }: SpanProps) {
  return (
    <>
      {segments.map((seg, i) => {
        /*
         * 样板文字按**片段**判定，不是按段落 ——
         * NASA 的尾部（记者名单 + 邮箱 + Related Terms）整个是一个段落，
         * 按段落判会把结尾那句真正的正文也涂灰。而锚点恰好都落在句首，
         * 逐片段判定在视觉上反而是齐的。
         */
        const note = boilerplateFrom >= 0 && seg.start >= boilerplateFrom;
        if (seg.kind !== 'word') {
          return (
            <span key={i} className={note ? 'note' : undefined}>
              {seg.text}
            </span>
          );
        }
        const word = seg.word ?? seg.text.toLowerCase();
        const cls = [
          'w',
          `lv${seg.level ?? 1}`,
          marked.has(word) ? 'marked' : '',
          focus && word === focus.toLowerCase() ? 'focus' : '',
          note ? 'note' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <span key={i} className={cls} onClick={() => onWord(word, seg.level ?? 1, seg.text)}>
            {seg.text}
          </span>
        );
      })}
    </>
  );
}

/**
 * 正文渲染：每个词是一个可点的 span，颜色表示难度、下划线表示已标记。
 *
 * 从 Reader 里拆出来 —— 分词到段落的还原逻辑与阅读会话的其他职责无关，
 * 混在一起会让 Reader 变成一坨。
 */
export function TextBody({ segments, marked, onWord, boilerplateFrom }: SpanProps) {
  const paragraphs = useMemo(() => toParagraphs(segments), [segments]);

  return (
    <article className="prose">
      {paragraphs.map((para, pi) => (
        <p key={pi}>
          <WordSpans
            segments={para}
            marked={marked}
            onWord={onWord}
            boilerplateFrom={boilerplateFrom}
          />
        </p>
      ))}
    </article>
  );
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
