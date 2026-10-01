import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AppState, WordRequest } from './types';
import {
  closePeek,
  drillPeek,
  goBack,
  goTab,
  initRouter,
  openPeek,
  previousLabel,
  TABS,
  useRoute,
  type Peek,
  type Tab,
} from './router';
import { useWordPanel } from './hooks/useWordPanel';
import { useFetchJob } from './hooks/useFetchJob';
import { Reader } from './components/Reader';
import { ReviewSession } from './components/ReviewSession';
import { TextLibrary } from './components/TextLibrary';
import { TextPanel } from './components/TextPanel';
import { WordList } from './components/WordList';
import { SettingsPanel } from './components/SettingsPanel';
import { WordCard } from './components/WordCard';

const TAB_LABEL: Record<Tab, string> = {
  learn: '阅读',
  review: '复习',
  texts: '文本库',
  words: '单词',
  settings: '设置',
};

/** 上一层叫什么 —— 「返回」按钮靠它告诉用户会回到哪。 */
function peekLabel(peek: Peek): string {
  return peek.kind === 'word' ? peek.word : '文章';
}

export function App() {
  const route = useRoute();
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  const reload = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBooted(true);
    }
  }, []);

  useEffect(() => {
    initRouter();
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onError = useCallback((message: string) => setError(message), []);
  const word = useWordPanel({ onStateChange: reload, onError });
  useFetchJob(state?.fetchJob, reload);

  // 主视图里点击 = 重新起一层（丢弃之前的面板路径）
  const openWordFromMain = useCallback(
    (r: WordRequest) => {
      const peek: Peek = { kind: 'word', word: r.word, level: r.level };
      openPeek(peek);
      void word.open(peek);
    },
    [word],
  );

  const openTextFromMain = useCallback((id: number) => {
    openPeek({ kind: 'text', id });
  }, []);

  // 面板里点击 = 压一层，并记下上一层叫什么（返回按钮的文案靠它）
  const openWordFromPanel = useCallback(
    (r: WordRequest) => {
      const peek: Peek = { kind: 'word', word: r.word, level: r.level };
      const cur = route.peek;
      drillPeek(peek, cur ? peekLabel(cur) : undefined);
      void word.open(peek);
    },
    [route.peek, word],
  );

  // URL 变了就把词卡详情同步过来（后退/前进/直接打开链接都走这条路）
  useEffect(() => {
    if (route.peek?.kind === 'word') void word.open(route.peek);
    else word.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.peek?.kind === 'word' ? `${route.peek.word}:${route.peek.level}` : null]);

  if (!booted) {
    return (
      <div className="boot">
        <div className="spinner" />
        载入中…
      </div>
    );
  }

  const due = state?.vocab.due ?? 0;
  const reading = state?.corpus.reading ?? 0;

  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav-brand">语境背单词</div>
        <div className="nav-list">
          {TABS.map((t) => (
            <button
              key={t}
              className={`nav-item${route.tab === t ? ' on' : ''}`}
              onClick={() => goTab(t)}
            >
              {TAB_LABEL[t]}
              {t === 'review' && due > 0 && <span className="badge">{due}</span>}
              {t === 'learn' && reading > 0 && <span className="badge">1</span>}
            </button>
          ))}
        </div>
        {state && (
          <div className="nav-foot">
            <Stat label="水平" value={`L${state.level}`} />
            <Stat label="生词" value={state.vocab.total ?? 0} />
            <Stat label="待验证" value={state.vocab.unverified ?? 0} />
            <Stat label="语料" value={state.corpus.texts} />
          </div>
        )}
      </nav>

      <main className="content">
        {error && (
          <div className="error">
            {error}
            <button className="chip" onClick={() => void reload()}>
              重试
            </button>
          </div>
        )}

        {/* key 让每次换页签重放一次进场动画 */}
        <div className="view" key={route.tab}>
          {route.tab === 'learn' && state && (
            <Reader state={state} onStateChange={reload} onOpenWord={openWordFromMain} />
          )}
          {route.tab === 'review' && state && (
            <ReviewSession state={state} onStateChange={reload} />
          )}
          {route.tab === 'texts' && (
            <TextLibrary onStateChange={reload} onOpenText={openTextFromMain} />
          )}
          {route.tab === 'words' && <WordList onOpenWord={openWordFromMain} />}
          {route.tab === 'settings' && state && (
            <SettingsPanel state={state} onStateChange={reload} />
          )}
        </div>
      </main>

      {route.peek && (
        <aside className="panel" key={route.peek.kind === 'word' ? route.peek.word : `t${route.peek.id}`}>
          <PanelBar label={previousLabel()} onBack={goBack} onClose={closePeek} />

          {route.peek.kind === 'text' ? (
            <TextPanel
              textId={route.peek.id}
              onOpenWord={openWordFromPanel}
              onStateChange={reload}
              onGoLearn={() => goTab('learn')}
            />
          ) : (
            <WordCard
              detail={word.detail}
              loading={word.loading}
              marked={word.marked}
              onMark={() => void word.toggleMark()}
              onUnmark={() => void word.toggleMark()}
            />
          )}
        </aside>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-k">{label}</span>
      <span className="stat-v">{value}</span>
    </div>
  );
}

/**
 * 面板顶部：返回上一层 / 关闭整个面板。
 *
 * 只用 SVG 图标不写文字 —— 两个按钮靠位置区分（左返回、右关闭），
 * 文字挤在 424px 的面板顶上会把标题压没。上一层的名字放 tooltip 里。
 */
function PanelBar({
  label,
  onBack,
  onClose,
}: {
  label: string | null;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="panel-bar">
      <button
        className="icon-btn"
        onClick={onBack}
        title={label ? `返回 ${label}` : '返回'}
        aria-label={label ? `返回 ${label}` : '返回'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <button className="icon-btn" onClick={onClose} title="关闭面板" aria-label="关闭面板">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
