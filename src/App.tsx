import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AppState, WordRequest } from './types';
import { useWordPanel } from './hooks/useWordPanel';
import { useFetchJob } from './hooks/useFetchJob';
import { Reader } from './components/Reader';
import { ReviewSession } from './components/ReviewSession';
import { TextLibrary } from './components/TextLibrary';
import { TextPanel } from './components/TextPanel';
import { WordList } from './components/WordList';
import { SettingsPanel } from './components/SettingsPanel';
import { WordCard } from './components/WordCard';

export type Tab = 'learn' | 'review' | 'texts' | 'words' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'learn', label: '阅读' },
  { key: 'review', label: '复习' },
  { key: 'texts', label: '文本库' },
  { key: 'words', label: '单词' },
  { key: 'settings', label: '设置' },
];

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>('learn');
  const [error, setError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  /** 侧边栏同时只显示一个东西：文本面板 或 词卡。 */
  const [textPanelId, setTextPanelId] = useState<number | null>(null);
  /** 词卡关掉后要回到哪个文本面板（从文本面板里点词进来时才有）。 */
  const [wordBackTo, setWordBackTo] = useState<number | null>(null);

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
    void reload();
  }, [reload]);

  const onError = useCallback((message: string) => setError(message), []);
  const panel = useWordPanel({ onStateChange: reload, onError });
  useFetchJob(state?.fetchJob, reload);

  const openWord = useCallback(
    (r: WordRequest) => {
      setTextPanelId(null);
      setWordBackTo(null);
      void panel.open(r);
    },
    [panel],
  );

  /** 文本库点开一篇 → 打开文本面板，**不**动当前阅读会话。 */
  const openText = useCallback(
    (id: number) => {
      panel.close();
      setWordBackTo(null);
      setTextPanelId(id);
    },
    [panel],
  );

  const closeWord = useCallback(() => {
    panel.close();
    if (wordBackTo !== null) {
      setTextPanelId(wordBackTo);
      setWordBackTo(null);
    }
  }, [panel, wordBackTo]);

  /** 文本面板里点词 → 词卡顶掉面板，但记住回程。 */
  const openWordFromText = useCallback(
    (r: WordRequest, from: number) => {
      setTextPanelId(null);
      setWordBackTo(from);
      void panel.open(r);
    },
    [panel],
  );

  const switchTab = (t: Tab) => {
    setTab(t);
    panel.close();
    setTextPanelId(null);
    setWordBackTo(null);
  };

  if (!booted) {
    return (
      <div className="loading">
        <div className="spinner" />
        载入中…
      </div>
    );
  }

  const due = state?.vocab.due ?? 0;
  const reading = state?.corpus.reading ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">语境背单词</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab${tab === t.key ? ' active' : ''}`}
              onClick={() => switchTab(t.key)}
            >
              {t.label}
              {t.key === 'review' && due > 0 && <span className="badge">{due}</span>}
              {t.key === 'learn' && reading > 0 && <span className="badge">1</span>}
            </button>
          ))}
        </nav>
        <div className="topbar-stats">
          {state && (
            <>
              <span>
                水平 <b>L{state.level}</b>
              </span>
              <span>
                生词 <b>{state.vocab.total ?? 0}</b>
              </span>
              <span>
                待验证 <b>{state.vocab.unverified ?? 0}</b>
              </span>
              <span>
                语料 <b>{state.corpus.texts}</b>
              </span>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="error">
          {error}
          <button className="btn" onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}

      <div className="main">
        {tab === 'learn' && state && (
          <Reader
            state={state}
            onStateChange={reload}
            onOpenWord={openWord}
            onMarked={panel.syncMarked}
          />
        )}
        {tab === 'review' && state && <ReviewSession state={state} onStateChange={reload} />}
        {tab === 'texts' && <TextLibrary onOpenText={openText} onStateChange={reload} />}
        {tab === 'words' && <WordList onOpenWord={openWord} />}
        {tab === 'settings' && state && <SettingsPanel state={state} onStateChange={reload} />}

        {textPanelId !== null && (
          <TextPanel
            key={textPanelId}
            textId={textPanelId}
            onClose={() => setTextPanelId(null)}
            onOpenWord={(r) => openWordFromText(r, textPanelId)}
            onStateChange={reload}
            onGoLearn={() => {
              setTextPanelId(null);
              setTab('learn');
            }}
          />
        )}

        {panel.request && (
          <WordCard
            detail={panel.detail}
            loading={panel.loading}
            marked={panel.marked}
            backLabel={wordBackTo !== null ? '返回文章' : undefined}
            onBack={wordBackTo !== null ? closeWord : undefined}
            onMark={() => void panel.toggleMark()}
            onUnmark={() => void panel.toggleMark()}
            onClose={closeWord}
          />
        )}
      </div>
    </div>
  );
}
