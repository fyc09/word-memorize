import { useCallback, useEffect, useState } from 'react';
import { api, PAGE } from '../api';
import { levelVar } from '../types';
import type { ActivityItem, Paged, TextDetail, WordRequest } from '../types';
import { ActivityLog, fmt } from './ActivityLog';
import { Pager } from './Pager';
import { TextBody } from './TextBody';

interface Props {
  textId: number;
  onClose: () => void;
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

export function TextPanel({ textId, onClose, onOpenWord, onStateChange, onGoLearn }: Props) {
  const [detail, setDetail] = useState<TextDetail | null>(null);
  const [log, setLog] = useState<Paged<ActivityItem> | null>(null);
  const [logOffset, setLogOffset] = useState(0);
  const [showBody, setShowBody] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setShowBody(false);
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
          <div className="spinner" />
          载入中…
        </div>
      </aside>
    );
  }

  const m = detail.meta;
  const markedSet = new Set(detail.markedWords.map((w) => w.word));

  return (
    <aside className="side wide">
      <div className="side-head">
        <div className="side-head-main">
          <div className="card-sub">
            <span className={`pill ${m.category}`}>{m.category}</span>
            <span>{m.source}</span>
            {m.status && <span className="pill reading">{STATUS_LABEL[m.status] ?? m.status}</span>}
            {detail.isCurrent && <span className="pill done">当前阅读</span>}
          </div>
        </div>
        <button className="btn btn-xs" onClick={onClose}>
          ✕
        </button>
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
          <em>标记</em>
          {m.n_marked ?? 0}
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

      {detail.markedWords.length > 0 && (
        <div className="card-section">
          <h3>标记的生词 ({detail.markedWords.length})</h3>
          <div className="taglist">
            {detail.markedWords.map((w) => (
              <button
                key={w.word}
                className="tagword"
                style={{ color: levelVar(w.level) }}
                onClick={() => void onOpenWord({ word: w.word, level: w.level, textId })}
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

      <div className="card-section">
        <div className="toolbar">
          <h3 className="no-margin">正文</h3>
          <button className="linkbtn push-right" onClick={() => setShowBody((v) => !v)}>
            {showBody ? '收起' : '展开全文'}
          </button>
        </div>
        {showBody ? (
          <div className="preview">
            <TextBody
              segments={detail.segments}
              marked={markedSet}
              showLevels
              onWord={(word, level) => void onOpenWord({ word, level, textId })}
            />
          </div>
        ) : (
          <p className="log-empty">共 {detail.segments.length} 个片段</p>
        )}
      </div>
    </aside>
  );
}
