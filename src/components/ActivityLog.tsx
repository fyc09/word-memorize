/**
 * append-only 流水的渲染。
 *
 * 文本库（按文本筛）与词卡（按词筛）展示的是同一份 activity，
 * 所以渲染也共用一处 —— 否则两处的「记录」迟早长得不一样。
 *
 * 折叠样式模仿 gtd-manager：箭头是 SVG，展开时转 90°；
 * 高度动画用 grid-template-rows 0fr → 1fr（能真正动画到内容高度，
 * 不需要预先知道有多高）。
 */

import { useState } from 'react';
import type { ActivityDetail, ActivityItem, WordRequest } from '../types';

export const KIND_LABEL: Record<string, string> = {
  read_start: '开始阅读',
  read_done: '读完',
  mark: '标记',
  unmark: '取消标记',
  review: '复习',
  fetch: '抓取语料',
};

const GRADE_LABEL: Record<string, string> = {
  cloze_good: '填空想起',
  cloze_fuzzy: '填空模糊',
  cloze_fail: '填空失败',
  reading_good: '阅读认识',
  reading_fail: '阅读不认识',
};

export function GradeTag({ detail }: { detail: ActivityDetail | null }) {
  const grade = detail?.grade;
  if (typeof grade !== 'string') return null;
  return (
    <span className={`pill ${grade.includes('good') ? 'done' : ''}`}>
      {GRADE_LABEL[grade] ?? grade}
    </span>
  );
}

/** 折叠箭头：指向右，展开时转 90° 指向下。 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chev${open ? ' is-open' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 5l7 7-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Props {
  items: ActivityItem[];
  onOpenWord?: (r: WordRequest) => void | Promise<void>;
  /** 词卡里标题已经写明是哪个词，不必再重复 */
  showWord?: boolean;
  /** 文本库里标题已知，不必再重复 */
  showText?: boolean;
}

export function ActivityLog({ items, onOpenWord, showWord = true, showText = true }: Props) {
  const [open, setOpen] = useState<number | null>(null);

  if (items.length === 0) return <p className="log-empty">暂无记录</p>;

  return (
    <ul className="log">
      {items.map((a) => {
        const isOpen = open === a.id;
        return (
          <li key={a.id} className="log-item">
            <div
              className={`log-row${isOpen ? ' head' : ''}`}
              onClick={() => setOpen(isOpen ? null : a.id)}
            >
              <span className="log-time">{fmt(a.at)}</span>
              <span className="log-kind">{KIND_LABEL[a.kind] ?? a.kind}</span>
              {showWord && a.word && (
                <button
                  className="log-word"
                  onClick={(e) => {
                    e.stopPropagation();
                    const w = a.word;
                    if (w) void onOpenWord?.({ word: w });
                  }}
                >
                  {a.word}
                </button>
              )}
              {showText && a.title && <span className="log-text">{a.title.slice(0, 40)}</span>}
              {a.kind === 'review' && <GradeTag detail={a.detail} />}
              <Chevron open={isOpen} />
            </div>

            {/* 折叠区：0fr → 1fr，能真正动画到内容自身的高度 */}
            <div className={`log-open${isOpen ? ' in' : ''}`}>
              <div className="log-open-in">
                <LogDetail item={a} onOpenWord={onOpenWord} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** 一条记录的展开详情，按 kind 决定展示什么。 */
function LogDetail({
  item,
  onOpenWord,
}: {
  item: ActivityItem;
  onOpenWord?: (r: WordRequest) => void | Promise<void>;
}) {
  const d = item.detail;

  if (item.kind === 'review') {
    return (
      <div className="log-detail">
        <Row label="方式" value={d?.mode === 'reading' ? '阅读模式' : '填空'} />
        <Row label="评分" value={d?.grade ? (GRADE_LABEL[d.grade] ?? d.grade) : '—'} />
        {/* 看过提示的「想起来了」含金量不同，必须看得到 */}
        <Row label="看过提示" value={d?.usedHint ? '是' : '否'} />
        <Row label="当时填的" value={d?.typed ? `“${d.typed}”` : '（没填）'} />
        {d?.prev !== undefined && d?.next !== undefined && (
          <Row label="间隔" value={`${d.prev} 天 → ${d.next} 天`} />
        )}
      </div>
    );
  }

  if (item.kind === 'read_done') {
    const words = d?.words ?? [];
    return (
      <div className="log-detail">
        <Row label="标记" value={`${d?.nMarked ?? words.length} 个`} />
        {words.length > 0 && (
          <div className="taglist">
            {words.map((w) => (
              <button key={w} className="tagword" onClick={() => void onOpenWord?.({ word: w })}>
                {w}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (item.kind === 'fetch') {
    return (
      <div className="log-detail">
        <Row label="扫描" value={`${d?.scanned ?? 0} 条`} />
        <Row label="新增" value={`${d?.ingested ?? 0} 篇`} />
        {d?.failed ? <Row label="丢弃" value={`${d.failed} 条`} /> : null}
      </div>
    );
  }

  return (
    <div className="log-detail">
      <Row label="出自" value={item.title ?? '（无关联文本）'} />
      {item.kind === 'unmark' && (
        <Row label="结果" value={d?.archived ? '归档（保留复习进度）' : '删除'} />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="log-detail-row">
      <span className="log-detail-label">{label}</span>
      <span className="log-detail-value">{value}</span>
    </div>
  );
}

/** 相对时间：同一天只显示时分，更早显示月日。 */
export function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}
