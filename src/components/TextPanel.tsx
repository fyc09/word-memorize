import { useCallback, useEffect, useState } from 'react';
import { api, PAGE } from '../api';
import { levelVar } from '../types';
import type { ActivityItem, Paged, Segment, TextDetail, WordRequest } from '../types';
import { ActivityLog, Chevron, fmt } from './ActivityLog';
import { Pager } from './Pager';
import { Spinner } from './Spinner';
import { TextBody } from './TextBody';

interface Props {
  textId: number;
  onOpenWord: (r: WordRequest) => void | Promise<void>;
  onStateChange: () => void | Promise<void>;
  /** 设为当前阅读后跳到阅读页 */
  onGoLearn: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  reading: '在读',
  done: '已读',
  dropped: '搁置',
};

export function TextPanel({ textId, onOpenWord, onStateChange, onGoLearn }: Props) {
  const [detail, setDetail] = useState<TextDetail | null>(null);
  const [log, setLog] = useState<Paged<ActivityItem> | null>(null);
  const [logOffset, setLogOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 「查看原文」的折叠状态与正文。
   *
   * 正文按需拉取：/api/texts/detail 刻意不含它（当初为省流量把 segments
   * 从 91.9KB 减到 533B），所以只在这一栏被展开时才去取。
   */
  const [bodyOpen, setBodyOpen] = useState(false);
  const [body, setBody] = useState<{ segments: Segment[]; boilerplateFrom: number } | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await api.textDetail(textId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [textId]);

  useEffect(() => {
    setLogOffset(0);
    void loadDetail();
  }, [textId, loadDetail]);

  useEffect(() => {
    void (async () => {
      try {
        setLog(await api.activity({ textId, offset: logOffset, limit: PAGE }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [textId, logOffset]);

  /** 把这篇设为当前阅读。这是唯一会开阅读会话的入口。 */
  const setCurrent = async () => {
    setBusy(true);
    try {
      await api.openText(textId);
      await onStateChange();
      onGoLearn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 展开时才去拉正文（拉过一次就留着，反复启不用重拉）。 */
  const toggleBody = async () => {
    const next = !bodyOpen;
    setBodyOpen(next);
    if (!next || body) return;
    setBodyLoading(true);
    try {
      setBody(await api.textBody(textId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBodyLoading(false);
    }
  };

  if (error && !detail) {
    return (
      <aside className="side wide">
        <div className="error">{error}</div>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="side wide">
        <div className="loading">
          <Spinner />
          载入中…
        </div>
      </aside>
    );
  }

  const m = detail.meta;

  return (
    <aside className="side wide">
      <div className="card-sub">
        <span className={`pill ${m.category}`}>{m.category}</span>
        <span>{m.source}</span>
        {m.status && <span className="pill reading">{STATUS_LABEL[m.status] ?? m.status}</span>}
        {detail.isCurrent && <span className="pill done">当前阅读</span>}
      </div>

      <h2 className="panel-title">{m.title ?? '无标题'}</h2>

      <div className="variants">
        <span className="variant">
          <em>词数</em>
          {m.word_count}
        </span>
        <span className="variant">
          <em>均级</em>
          L{m.avg_level.toFixed(1)}
        </span>
        <span className="variant">
          <em>读过</em>
          {m.times_read}
        </span>
      </div>

      <div className="timeline">
        <div>
          <span className="muted">开始</span> {m.started_at ? fmt(m.started_at) : '未读'}
        </div>
        <div>
          <span className="muted">完成</span> {m.finished_at ? fmt(m.finished_at) : '—'}
        </div>
      </div>

      <div className="btn-row">
        {detail.isCurrent ? (
          <button className="btn wide" onClick={onGoLearn}>
            继续阅读
          </button>
        ) : (
          <button className="btn primary wide" disabled={busy} onClick={() => void setCurrent()}>
            设为当前阅读
          </button>
        )}
      </div>

      <div className="card-section">
        <button className="fold-head" type="button" onClick={() => void toggleBody()}>
          原文
          <Chevron open={bodyOpen} />
        </button>
        <div className={`fold-body${bodyOpen ? ' in' : ''}`}>
          <div className="fold-body-in">
            {bodyLoading && (
              <div className="loading">
                <Spinner />
              </div>
            )}
            {!bodyLoading && body && (
              <TextBody
                segments={body.segments}
                marked={new Set(detail.markedWords.map((w) => w.word))}
                /* 在这篇正文里点词，出处就是这篇 */
                onWord={(word, level) => void onOpenWord({ word, level, origin: { textId } })}
                boilerplateFrom={body.boilerplateFrom}
              />
            )}
          </div>
        </div>
      </div>

      {detail.markedWords.length > 0 && (
          <div className="card-section">
            {/* 计数只写在这里。上方元信息行里原本还有一个「标记 N」，
                同一个数字在同一屏出现两遍没有意义 */}
            <h3>标记的生词 ({detail.markedWords.length})</h3>
          <div className="taglist">
            {detail.markedWords.map((w) => (
              <button
                key={w.word}
                className="tagword"
                style={{ color: levelVar(w.level) }}
                onClick={() => void onOpenWord({ word: w.word, level: w.level })}
              >
                {w.word}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card-section">
        <h3>记录 ({log?.total ?? 0})</h3>
        <ActivityLog items={log?.items ?? []} onOpenWord={onOpenWord} showText={false} />
        {log && (
          <Pager total={log.total} offset={log.offset} limit={log.limit} onChange={setLogOffset} />
        )}
      </div>
    </aside>
  );
}
