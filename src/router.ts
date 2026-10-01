/**
 * 手写 router。
 *
 * 为什么不用 react-router：只有 5 条静态路由，没有嵌套路由、没有按路由分包，
 * 而且**实体不是页面**（面板只是浮在主视图上的 peek），所以 `path="/word/:word"`
 * 这类最值钱的能力用不上。「首次 push」的模型也要自己包一层。
 * 60 行手写比引一个 15 KB 的库更划算。
 *
 * 状态模型：
 *   URL   = 当前可见状态（页签 + 列表参数 + 栈顶那一个 peek）
 *   history = 路径本身。每一层压一条，所以浏览器后退天然就是逐层返回。
 *
 * 因为每个历史条目的 URL 都能完整决定那一层画面，`popstate` 时只要
 * 重新解析 URL 就能渲染，不需要在内存里再维护一份栈。
 */

import { useSyncExternalStore } from 'react';

export const TABS = ['learn', 'review', 'texts', 'words', 'settings'] as const;
export type Tab = (typeof TABS)[number];

/** 面板里的一次「看一眼」。 */
export type Peek =
  | { kind: 'word'; word: string; level?: number }
  | { kind: 'text'; id: number };

export interface Route {
  pathname: string;
  tab: Tab;
  params: URLSearchParams;
  /** 当前栈顶的 peek，没有则为 null */
  peek: Peek | null;
}

// ---------------------------------------------------------------- 编解码

/**
 * peek 编成 `<kind>:<value>[:<level>]`。
 *
 * 不用转义：词表里 401,818 个词全部只含 `[A-Za-z'-]`（已验证无冒号），
 * id 与等级都是整数，所以冒号天然是安全分隔符。
 */
export function encodePeek(p: Peek): string {
  if (p.kind === 'text') return `text:${p.id}`;
  return p.level === undefined ? `word:${p.word}` : `word:${p.word}:${p.level}`;
}

export function decodePeek(raw: string | null): Peek | null {
  if (!raw) return null;
  const [kind, value, level] = raw.split(':');
  if (!value) return null;
  if (kind === 'text') {
    const id = Number(value);
    return Number.isInteger(id) ? { kind: 'text', id } : null;
  }
  if (kind === 'word') {
    const lv = Number(level);
    return Number.isInteger(lv) && level !== undefined
      ? { kind: 'word', word: value, level: lv }
      : { kind: 'word', word: value };
  }
  return null;
}

export function tabFromPath(pathname: string): Tab {
  const seg = pathname.replace(/^\/+|\/+$/g, '');
  return (TABS as readonly string[]).includes(seg) ? (seg as Tab) : 'learn';
}

export const pathForTab = (tab: Tab): string => `/${tab}`;

// ---------------------------------------------------------------- 订阅

interface NavState {
  app: true;
  /** 0 = 主视图；1 = 第一个面板层；以此类推 */
  depth: number;
  /** 这个条目是我们自己压出来的吗。直接打开分享链接时没有上一条可退，记为 true */
  root: boolean;
  /**
   * 上一层叫什么。
   * 没有面包屑之后，「返回」按钮是唯一的方位线索 —— 把上一层的名字
   * 记在 history.state 里，按钮就能写「← 返回 subtle」而不是干巴巴一个「返回」。
   * 代价只有一个字符串。
   */
  from?: string;
}

function read(): Route {
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    // location.href 理论上总是合法的；真出现异常时退回根路径，
    // 而不是让整个应用在解析阶段就崩掉
    url = new URL('http://localhost/');
  }
  return {
    pathname: url.pathname,
    tab: tabFromPath(url.pathname),
    params: url.searchParams,
    peek: decodePeek(url.searchParams.get('open')),
  };
}

// getRoute 必须返回稳定引用，否则 useSyncExternalStore 会死循环：
// 只在 emit 时重建
let cache: Route = read();
const listeners = new Set<() => void>();

function emit() {
  cache = read();
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getRoute(): Route {
  return cache;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRoute, getRoute);
}

// ---------------------------------------------------------------- 导航

function navState(): NavState | null {
  const s = history.state;
  return s && s.app === true ? (s as NavState) : null;
}

/** 当前面板深度。直接打开链接时为 1（URL 里已经有 open）。 */
export function panelDepth(): number {
  return navState()?.depth ?? 0;
}

/** 这个历史条目是不是「深度链接进来的第一层」——没有上一条可退。 */
function isRootEntry(): boolean {
  return navState()?.root === true;
}

function apply(
  url: string,
  { replace = false, depth = 0, root = false, from }: { replace?: boolean; depth?: number; root?: boolean; from?: string } = {},
) {
  const state: NavState = { app: true, depth, root };
  if (from) state.from = from;
  if (replace) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
  emit();
}

function cloneParams(params: URLSearchParams): URLSearchParams {
  return new URLSearchParams(params.toString());
}

/** 把某个 peek 写进当前 URL 的参数里（不动其他参数）。 */
function withPeek(peek: Peek | null, base?: URLSearchParams): string {
  const params = cloneParams(base ?? getRoute().params);
  if (peek) params.set('open', encodePeek(peek));
  else params.delete('open');
  const q = params.toString();
  return `${pathForTab(getRoute().tab)}${q ? `?${q}` : ''}`;
}

/**
 * 应用启动时调用一次。
 *
 * 直接打开分享链接（`/read?open=word:x`）时 history.state 是空的，
 * 这里的 depth 会被记成 1 且标记为 root —— 之后「返回」「关闭」就知道
 * 没有上一条可退，改用 replace 清掉 open，而不是把用户带出应用。
 */
export function initRouter() {
  const r = read();
  const canonical = `${pathForTab(r.tab)}${location.search}`;
  const state = navState();

  if (!state) {
    // 直接打开分享链接（/read?open=word:x）时 history.state 是空的。
    // depth 记成 1 且标记 root —— 之后「返回」「关闭」就知道没有上一条可退，
    // 改用 replace 清掉 open，而不是把用户带出应用。
    history.replaceState({ app: true, depth: r.peek ? 1 : 0, root: true }, '', canonical);
  } else if (location.pathname !== pathForTab(r.tab)) {
    // 把 `/` 这类路径规范成 `/learn`，否则同一个页面有两个 URL
    history.replaceState(state, '', canonical);
  }
  emit();
}

/** 切页签：不清空 open 的话会看到「根是阅读页、主视图已是文本库」的错位。 */
export function goTab(tab: Tab) {
  apply(pathForTab(tab), { depth: 0 });
}

/** 上一层叫什么，用于「返回」按钮的文案；没有则为 null。 */
export function previousLabel(): string | null {
  return navState()?.from ?? null;
}

/** 只改列表参数（分页/筛选）。搜索框输入请传 replace，否则每个键都压一条历史。 */
export function setParams(
  patch: Record<string, string | number | undefined>,
  { replace = false } = {},
) {
  const params = cloneParams(getRoute().params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') params.delete(k);
    else params.set(k, String(v));
  }
  const q = params.toString();
  const url = `${pathForTab(getRoute().tab)}${q ? `?${q}` : ''}`;
  // depth 不变：改列表参数不算深入一层
  const st = navState();
  apply(url, { replace, depth: st?.depth ?? 0, root: st?.root ?? false, from: st?.from });
}

/** 主视图里点击 → 重新起一层（丢弃之前的面板路径）。 */
export function openPeek(peek: Peek) {
  apply(withPeek(peek), { depth: 1 });
}

/**
 * 面板里继续点 → 压一层。
 * @param from 上一层叫什么（当前正在看的那个东西），用于返回按钮文案
 */
export function drillPeek(peek: Peek, from?: string) {
  apply(withPeek(peek), { depth: panelDepth() + 1, from });
}

function clearPeek() {
  apply(withPeek(null), { replace: true });
}

/** 返回一层。栈底或深度链接的第一层 → 直接关掉面板。 */
export function goBack() {
  if (panelDepth() > 0 && !isRootEntry()) history.back();
  else clearPeek();
}

/** 直接关闭整个面板（用户在深栈里想一步脱身）。 */
export function closePeek() {
  const depth = panelDepth();
  if (depth > 0 && !isRootEntry()) history.go(-depth);
  else clearPeek();
}

// popstate 由浏览器触发，这里只需重新解析并通知
window.addEventListener('popstate', emit);
