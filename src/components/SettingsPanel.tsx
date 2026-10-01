import { useState } from 'react';
import { api } from '../api';
import type { AppState } from '../types';
import { fmt } from './ActivityLog';

interface Props {
  state: AppState;
  onStateChange: () => void | Promise<void>;
}

export function SettingsPanel({ state, onStateChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setLevel = async (level: number) => {
    setBusy(true);
    setError(null);
    try {
      await api.setSettings({ level });
      await onStateChange();
      setMsg(`水平 L${level}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleCategory = async (cat: string) => {
    const cur = new Set(state.categories);
    if (cur.has(cat)) cur.delete(cat);
    else cur.add(cat);
    setBusy(true);
    setError(null);
    try {
      await api.setSettings({ categories: [...cur] });
      await onStateChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 抓取：只负责「启动」，不等结果。
   * 服务端立刻返回，抓取在后台跑；这里调 onStateChange 后
   * state.fetchJob 会变成 running，按钮随之置灰。
   */
  const startFetch = async () => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const { alreadyRunning } = await api.fetchStart(12);
      await onStateChange();
      setMsg(alreadyRunning ? '已有抓取任务在跑' : '已开始抓取');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const job = state.fetchJob;
  const running = job?.status === 'running';
  const levelChoices = state.levels.filter((l) => l.level > 0);
  const reviewed = state.reviews.total ?? 0;
  const acc = reviewed > 0 ? ((state.reviews.ok ?? 0) / reviewed) * 100 : 0;

  return (
    <div className="wrap">
      <div className="page">
        {error && <div className="error">{error}</div>}

        <div className="section">
          <h2>我的水平</h2>
          <div className="chips">
            {levelChoices.map((l) => (
              <button
                key={l.level}
                className={`chip${state.level === l.level ? ' on' : ''}`}
                disabled={busy}
                onClick={() => void setLevel(l.level)}
              >
                L{l.level} {l.name}
              </button>
            ))}
          </div>
        </div>

        <div className="section">
          <h2>题材偏好</h2>
          <div className="chips">
            {Object.values(state.categoriesMeta).map((c) => (
              <button
                key={c.key}
                className={`chip${state.categories.includes(c.key) ? ' on' : ''}`}
                disabled={busy}
                onClick={() => void toggleCategory(c.key)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <div className="section">
          <h2>语料库</h2>
          <div className="variants">
            <span className="variant">
              <em>总计</em>
              {state.corpus.texts}
            </span>
            <span className="variant">
              <em>已读</em>
              {state.corpus.readTexts}
            </span>
            <span className="variant">
              <em>在读</em>
              {state.corpus.reading}
            </span>
            <span className="variant">
              <em>未读</em>
              {state.corpus.unread}
            </span>
          </div>

          <div className="btn-row">
            <button className="btn primary" disabled={running || busy} onClick={() => void startFetch()}>
              {running ? '正在抓取' : '抓取新文章'}
            </button>
            {running && <span className="muted">后台进行中，可以离开本页</span>}
          </div>

          {job && (
            <p className="desc">
              {job.status === 'running' && `开始于 ${fmt(job.startedAt)}`}
              {job.status === 'done' &&
                job.result &&
                `上次 ${
                  job.result.ingested ?? 0
                } 篇 / 扫描 ${job.result.scanned ?? 0} 条 / ${fmt(job.finishedAt ?? job.startedAt)}`}
              {job.status === 'error' && `上次失败：${job.error}`}
            </p>
          )}
        </div>

        <div className="section">
          <h2>学习统计</h2>
          <div className="variants">
            <span className="variant">
              <em>生词总数</em>
              {state.vocab.total ?? 0}
            </span>
            <span className="variant">
              <em>已填空验证</em>
              {state.vocab.verified ?? 0}
            </span>
            <span className="variant">
              <em>待验证</em>
              {state.vocab.unverified ?? 0}
            </span>
            <span className="variant">
              <em>已掌握</em>
              {state.vocab.mature ?? 0}
            </span>
            <span className="variant">
              <em>到期</em>
              {state.vocab.due}
            </span>
          </div>
          <div className="variants mt-10">
            <span className="variant">
              <em>复习次数</em>
              {reviewed}
            </span>
            <span className="variant">
              <em>其中填空</em>
              {state.reviews.cloze ?? 0}
            </span>
            <span className="variant">
              <em>其中阅读</em>
              {state.reviews.reading ?? 0}
            </span>
            <span className="variant">
              <em>通过率</em>
              {acc.toFixed(0)}%
            </span>
          </div>
        </div>

        {msg && <div className="notice">{msg}</div>}
      </div>
    </div>
  );
}
