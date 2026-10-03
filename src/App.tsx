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
import { Spinner } from './components/Spinner';

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

  /**
   * 难度显示开关。
   * 存服务端设置而不是本地 state —— 它是全局开关，
   * 换页签、刷新、下次打开都该保持。
   */
  const setShowLevels = useCallback(
    async (on: boolean) => {
      try {
        await api.setSettings({ showLevels: on });
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [reload],
  );

  // 正文里已标记的词。放在 App 而不是 Reader —— 词卡（旁边一列）里标记后，
  // 正文要立刻长出下划线，两边得共用一个来源。
  const [markedWords, setMarkedWords] = useState<Set<string>>(new Set());
  const onMarkedWords = useCallback((words: string[]) => setMarkedWords(new Set(words)), []);
  const onMarkedChange = useCallback((w: string, m: boolean) => {
    setMarkedWords((prev) => {
      const next = new Set(prev);
      if (m) next.add(w);
      else next.delete(w);
      return next;
    });
  }, []);

  const word = useWordPanel({ onStateChange: reload, onError, onMarkedChange });
  useFetchJob(state?.fetchJob, reload);

  // 主视图里点击 → 打开面板。
  // 注意 depth 会累加（见 router.ts）：主视图可以反复点，关闭要一次全关。
  // 传 r 而不是 peek：出处（在哪篇文章/哪一句遇到的）只有 r 带着，
  // 而 peek 是要进地址栏的，不装这种一次性上下文。
  const openWordFromMain = useCallback(
    (r: WordRequest) => {
      openPeek({ kind: 'word', word: r.word, level: r.level });
      void word.open(r);
    },
    [word],
  );

  const openTextFromMain = useCallback((id: number) => {
    openPeek({ kind: 'text', id });
  }, []);

  /**
   * 面板里点「出自」→ 压一层看那一篇。
   * 已经在这一篇里（在文本库详情页里点自己）就什么也不做，
   * 否则会白白堆一层一模一样的面板。
   */
  const openTextFromPanel = useCallback(
    (id: number) => {
      const cur = route.peek;
      if (cur?.kind === 'text' && cur.id === id) return;
      drillPeek({ kind: 'text', id }, cur ? peekLabel(cur) : undefined);
    },
    [route.peek],
  );

  // 面板里点击 = 压一层，并记下上一层叫什么（返回按钮的文案靠它）
  const openWordFromPanel = useCallback(
    (r: WordRequest) => {
      const peek: Peek = { kind: 'word', word: r.word, level: r.level };
      const cur = route.peek;
      drillPeek(peek, cur ? peekLabel(cur) : undefined);
      void word.open(r);
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
        <Spinner />
        载入中…
      </div>
    );
  }

  const due = state?.vocab.due ?? 0;
  const reading = state?.corpus.reading ?? 0;

  return (
    /* no-levels 把各档颜色变量归到正文本色（见 styles.css），
       一处生效即覆盖正文、词卡与所有列表 —— 不必逐组件传开关。 */
    <div className={`shell${state && !state.showLevels ? ' no-levels' : ''}`}>
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

            <label className="toggle nav-switch">
              <input
                type="checkbox"
                className="switch-input"
                checked={state.showLevels}
                onChange={(e) => void setShowLevels(e.target.checked)}
              />
              <span className="switch" />
              难度
            </label>
          </div>
        )}
      </nav>

      <main className="content">
        {/*
          key 让每次换页签重放一次进场动画。
          data-tab 决定这一列的宽度（阅读窄、列表宽）—— 宽度统一由 .view
          负责，各视图自己不再各自 max-width，所以错误横幅放在这里面
          才能真的和内容对齐。
        */}
        <div className="view" data-tab={route.tab} key={route.tab}>
          {error && (
            <div className="error">
              {error}
              <button className="chip" onClick={() => void reload()}>
                重试
              </button>
            </div>
          )}

          {route.tab === 'learn' && state && (
            <Reader
              state={state}
              marked={markedWords}
              onMarkedWords={onMarkedWords}
              onStateChange={reload}
              onOpenWord={openWordFromMain}
            />
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
              onOpenText={openTextFromPanel}
              onStateChange={reload}
              onGoLearn={() => goTab('learn')}
            />
          ) : (
            <WordCard
              detail={word.detail}
              loading={word.loading}
              marked={word.marked}
              onOpenWord={openWordFromPanel}
              onOpenText={openTextFromPanel}
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
