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

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ActivityDetail, ActivityItem, Segment, WordRequest } from '../types';
import { WordSpans } from './TextBody';

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

/**
 * 评分。
 *
 * 和「复习」「标记」用同一档文字（.log-kind），不做成药丸 ——
 * 一行里塞一个彩色胶囊，时间和类型反而被挤成了陪衬。
 */
export function GradeTag({ detail }: { detail: ActivityDetail | null }) {
  const grade = detail?.grade;
  if (typeof grade !== 'string') return null;
  return <span className="log-kind">{GRADE_LABEL[grade] ?? grade}</span>;
}

/** 折叠箭头：指向右，展开时转 90° 指向下。文本库的「查看原文」也用。 */
export function Chevron({ open }: { open: boolean }) {
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
  /** 点「出自」时打开那一篇的详情 */
  onOpenText?: (textId: number) => void | Promise<void>;
  /** 词卡里标题已经写明是哪个词，不必再重复 */
  showWord?: boolean;
}

export function ActivityLog({ items, onOpenWord, onOpenText, showWord = true }: Props) {
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
                  type="button"
                  onClick={(e) => {
                    // 别让点击冒泡到整行 —— 那是展开/收起
                    e.stopPropagation();
                    const w = a.word;
                    if (w) void onOpenWord?.({ word: w });
                  }}
                >
                  {a.word}
                </button>
              )}
              {a.kind === 'review' && <GradeTag detail={a.detail} />}
              <Chevron open={isOpen} />
            </div>

            {/* 折叠区：0fr → 1fr，能真正动画到内容自身的高度 */}
            <div className={`fold-body${isOpen ? ' in' : ''}`}>
              <div className="fold-body-in">
                <LogDetail
                  item={a}
                  open={isOpen}
                  onOpenWord={onOpenWord}
                  onOpenText={onOpenText}
                />
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
  open,
  onOpenWord,
  onOpenText,
}: {
  item: ActivityItem;
  open: boolean;
  onOpenWord?: (r: WordRequest) => void | Promise<void>;
  onOpenText?: (textId: number) => void | Promise<void>;
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
        {/* 复习和标记一样要有「出自」—— 同一个字段在所有记录里都得在同一个位置上 */}
        <Row
          label="出自"
          value={item.title ?? '（无关联文本）'}
          onClick={
            item.text_id && item.title ? () => void onOpenText?.(item.text_id as number) : undefined
          }
          title={item.title}
        />
        <Quote item={item} open={open} onOpenWord={onOpenWord} />
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
              <button
                key={w}
                className="tagword"
                type="button"
                onClick={() => void onOpenWord?.({ word: w })}
              >
                {w}
              </button>
            ))}
          </div>
        )}
        <Quote item={item} open={open} onOpenWord={onOpenWord} />
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
      <Row
        label="出自"
        value={item.title ?? '（无关联文本）'}
        onClick={item.text_id && item.title ? () => void onOpenText?.(item.text_id as number) : undefined}
        title={item.title}
      />
      {item.kind === 'unmark' && (
        <Row label="结果" value={d?.archived ? '归档（保留复习进度）' : '删除'} />
      )}
      <Quote item={item} open={open} onOpenWord={onOpenWord} />
    </div>
  );
}

/**
 * 原句（若有）。
 *
 * 只在展开时挂载：分词是按需拉的，一直挂着会给每条记录都发一次请求。
 */
function Quote({
  item,
  open,
  onOpenWord,
}: {
  item: ActivityItem;
  open: boolean;
  onOpenWord?: (r: WordRequest) => void | Promise<void>;
}) {
  if (!open) return null;
  const sentenceId = item.detail?.sentenceId;
  if (!sentenceId || !item.sentence) return null;
  return (
    <SentenceQuote
      sentenceId={sentenceId}
      fallback={item.sentence}
      focus={item.word}
      onOpenWord={onOpenWord}
    />
  );
}

/**
 * 记录里那句原句。
 *
 * 用和例句完全相同的组件（WordSpans）—— 按难度着色、每个词可点、目标词高亮。
 *
 * 分词是展开时才拉的：一句的 JSON 约 2.6KB，25 条就是 65KB，
 * 而记录列表本身只有 1.4KB。拉到之前先显示纯文本，避免空一下再跳出内容。
 */
function SentenceQuote({
  sentenceId,
  fallback,
  focus,
  onOpenWord,
}: {
  sentenceId: number;
  fallback: string;
  focus: string | null;
  onOpenWord?: (r: WordRequest) => void | Promise<void>;
}) {
  const [data, setData] = useState<{ segments: Segment[]; markedWords: string[] } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .sentence(sentenceId)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        /* 拉不到就继续用纯文本，不必为此打扰用户 */
      });
    return () => {
      alive = false;
    };
  }, [sentenceId]);

  if (!data) return <p className="log-quote">{fallback}</p>;

  return (
    <p className="log-quote">
      <WordSpans
        segments={data.segments}
        marked={new Set(data.markedWords)}
        focus={focus}
        onWord={(word, level) => void onOpenWord?.({ word, level })}
      />
    </p>
  );
}

function Row({
  label,
  value,
  onClick,
  title,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  title?: string | null;
}) {
  return (
    <div className="log-detail-row">
      <span className="log-detail-label">{label}</span>
      {onClick ? (
        <button className="log-src" type="button" onClick={onClick} title={title ?? undefined}>
          {value}
        </button>
      ) : (
        <span className="log-detail-value">{value}</span>
      )}
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
