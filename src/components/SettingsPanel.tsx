import { useState } from 'react';
import { api } from '../api';
import type { AppState } from '../types';
import { fmt } from './ActivityLog';

interface Props {
  state: AppState;
  onStateChange: () => void | Promise<void>;
  username: string;
  onLogout: () => Promise<void>;
}

/** VAPID 公钥是 base64url，subscribe 要的是 Uint8Array。 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function SettingsPanel({ state, onStateChange, username, onLogout }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 提醒时间的临时输入（加进列表前不落库） */
  const [draft, setDraft] = useState('');

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await onLogout();
    } catch (err) {
      setError(err instanceof Error ? err.message : '退出失败，请重试');
      setBusy(false);
    }
  };

  const setLevel = async (level: number) => {
    setBusy(true);
    setError(null);
    try {
      await api.setSettings({ level });
      await onStateChange();
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
    try {
      // 不需要把结果回声给用户：按钮会变成「正在抓取」并置灰，
      // 下面那行还会显示开始时间。
      await api.fetchStart(12);
      await onStateChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 定时抓取的时刻。空字符串表示关闭。 */
  const setFetchTime = async (time: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.setSettings({ fetchTime: time });
      await onStateChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleRemind = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.setSettings({ remindEnabled: on });
      await onStateChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 增减一个提醒时刻。时间列表排序后存，展示顺序就稳定。 */
  const setTimes = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.setSettings({ remindTimes: [...new Set(next)].sort() });
      await onStateChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addTime = async () => {
    if (!draft) return;
    await setTimes([...state.notify.times, draft]);
    setDraft('');
  };

  /**
   * 启用浏览器通知：申请权限 → 用服务端的 VAPID 公钥订阅 → 把订阅交给服务端存起来。
   *
   * 三步都可能失败且原因不同（不支持 / 权限被拒 / 订阅失败），
   * 必须分开报，否则用户只知道「不行」却不知道该去改哪里。
   */
  const enablePush = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('这个浏览器不支持推送通知');
      }
      // Service Worker 要安全上下文：https 或 localhost
      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        throw new Error('通知权限被拒绝，需要在浏览器地址栏左侧的站点设置里允许');
      }
      const { publicKey } = await api.pushKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await api.pushSubscribe(sub.toJSON() as PushSubscriptionJSON);
      await onStateChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 发一条测试通知，把服务端的失败原因带出来。 */
  const testPush = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.pushTest();
      if (r.subscriptions === 0) throw new Error('还没有订阅：先点「启用通知」');
      if (r.sent === 0) {
        const first = r.results[0];
        throw new Error(`发送失败：${first?.error || `HTTP ${first?.status ?? 0}`}`);
      }
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

        <div className="section login-account">
          <h2 className="section-title">{username}</h2>
          <button className="btn" disabled={busy} onClick={() => void logout()}>退出登录</button>
        </div>

        <div className="section">
          <h2 className="section-title">我的水平</h2>
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
          <h2 className="section-title">题材偏好</h2>
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
          <h2 className="section-title">语料库</h2>
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
            {/* 只说「可以离开」这件按钮上看不出来的事，
                前半句「后台进行中」已经在按钮上了 */}
            {running && <span className="muted">可以离开本页</span>}
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
          <h2 className="section-title">定时与提醒</h2>

          {/* 抓取时刻：任意 HH:MM，不是只能选整点 */}
          <div className="btn-row">
            <input
              type="time"
              className="search time-input"
              value={state.notify.fetchTime ?? ''}
              disabled={busy}
              onChange={(e) => void setFetchTime(e.target.value)}
            />
            <span className="muted">每天这个时刻抓取新文章</span>
            {state.notify.fetchTime && (
              <button className="btn" disabled={busy} onClick={() => void setFetchTime('')}>
                关闭
              </button>
            )}
          </div>

          <label className="toggle nav-switch mt-10">
            <input
              type="checkbox"
              className="switch-input"
              checked={state.notify.remindEnabled}
              disabled={busy}
              onChange={(e) => void toggleRemind(e.target.checked)}
            />
            <span className="switch" />
            有词到期或今天没学时提醒
          </label>

          {state.notify.remindEnabled && (
            <>
              <div className="btn-row mt-10">
                <input
                  type="time"
                  className="search time-input"
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void addTime();
                    }
                  }}
                />
                <button className="btn" disabled={busy || !draft} onClick={() => void addTime()}>
                  添加
                </button>
              </div>

              {state.notify.times.length === 0 ? (
                <p className="desc">还没有提醒时刻</p>
              ) : (
                <div className="chips chips-wrap">
                  {state.notify.times.map((t) => (
                    <button
                      key={t}
                      className="chip on"
                      disabled={busy}
                      title="点一下删除"
                      onClick={() => void setTimes(state.notify.times.filter((x) => x !== t))}
                    >
                      {t} ×
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="btn-row">
            <button className="btn primary" disabled={busy} onClick={() => void enablePush()}>
              {state.notify.subscriptions > 0 ? '重新启用通知' : '启用通知'}
            </button>
            <button
              className="btn"
              disabled={busy || state.notify.subscriptions === 0}
              onClick={() => void testPush()}
            >
              发一条测试
            </button>
          </div>

          <p className="desc">
            {state.notify.subscriptions > 0
              ? `${state.notify.subscriptions} 个浏览器已订阅`
              : '通知需要浏览器授权；仅 https 或 localhost 可用'}
          </p>
        </div>

        <div className="section">
          <h2 className="section-title">学习统计</h2>
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
      </div>
    </div>
  );
}
