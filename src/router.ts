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
  /**
   * 面板栈深 = 要退几条历史才能回到「无面板」那一层。
   *
   * 0 = 主视图；1 = 第一个面板层；以此类推。
   * 「关闭」就是 `history.go(-depth)`。切页签、从主视图点开、面板内深入
   * 都会显式写这个值，所以它和「当前面板有几层」始终一致。
   *
   * 前提是 initRouter 会给深链补一条「无面板」的底层，
   * 否则 depth 会比实际可退的条数多 1，`go(-depth)` 会退过头。
   */
  depth: number;
  /** 这个条目是我们自己压出来的吗。直接打开分享链接时为 true */
  root: boolean;
  /**
   * 上一层叫什么。
   * 没有面包屑之后，「返回」按钮是唯一的方位线索 —— 把上一层的名字
   * 记在 history.state 里，tooltip 就能写「返回 subtle」而不是干巴巴一个「返回」。
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

/** 当前面板深度。 */
export function panelDepth(): number {
  return navState()?.depth ?? 0;
}

function apply(
  url: string,
  {
    replace = false,
    depth = 0,
    root = false,
    from,
  }: { replace?: boolean; depth?: number; root?: boolean; from?: string } = {},
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
 * 直接打开分享链接（`/read?open=word:x`）时，URL 里已经有面板，但它背后
 * 没有「无面板」的那一条 —— 那样「关闭」就没地方退，只能退出去应用。
 * 所以这里把无面板的那一层垫到底下，让深链与普通进入的语义统一：
 *
 *   [/review]  ← 无面板
 *   [/review?open=text:125]
 *
 * 这样「关闭」永远是 `history.go(-depth)`，「返回」永远是 `history.back()`，
 * 两种进入方式语义一致。
 */
export function initRouter() {
  const r = read();
  const canonical = `${pathForTab(r.tab)}${location.search}`;

  if (navState()) {
    // 已在本次会话中（例如热重载）—— 只把 `/` 这类路径规范成 `/learn`
    if (location.pathname !== pathForTab(r.tab)) {
      history.replaceState(navState(), '', canonical);
    }
    emit();
    return;
  }

  if (r.peek) {
    // 必须在 replaceState **之前**把原 URL 存下来：
    // replaceState 会立刻改写 location.href，之后读到的已经是剥掉 open 的那个，
    // 再 push 就会把面板叠没。
    const original = location.href;
    history.replaceState({ app: true, depth: 0, root: true }, '', withPeek(null));
    history.pushState({ app: true, depth: 1, root: false }, '', original);
  } else {
    history.replaceState({ app: true, depth: 0, root: true }, '', canonical);
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

/** 返回一层。已经在本会话最底下时 → 直接关掉面板。 */
export function goBack() {
  if (panelDepth() > 0) history.back();
  else clearPeek();
}

/**
 * 直接关闭整个面板。
 *
 * 语义是「无论当前在哪一层，都让侧边栏关掉」—— 所以一律退到无面板的那一层，
 * 而不是逐层退。depth 就是「要退几条」，因为每次 push 都会显式写它。
 */
export function closePeek() {
  const depth = panelDepth();
  if (depth > 0) history.go(-depth);
  else clearPeek();
}

// popstate 由浏览器触发，这里只需重新解析并通知
window.addEventListener('popstate', emit);
