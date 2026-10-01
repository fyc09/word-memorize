/**
 * 单词面板的状态。
 *
 * 从 App 里抽出来 —— 面板的开关、详情加载、标记/取消标记是自成一体的一组职责，
 * 和「页签路由」「后台任务轮询」混在一起会让 App 难以阅读。
 */

import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import type { WordDetail, WordRequest } from '../types';

interface Options {
  onStateChange: () => void | Promise<void>;
  onError: (message: string) => void;
}

export function useWordPanel({ onStateChange, onError }: Options) {
  const [request, setRequest] = useState<WordRequest | null>(null);
  const [detail, setDetail] = useState<WordDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // 连点不同单词时只认最后一次请求的结果
  const reqId = useRef(0);

  const open = useCallback(
    async (r: WordRequest) => {
      setRequest(r);
      setLoading(true);
      const id = ++reqId.current;
      try {
        const d = await api.word(r.word, r.textId, r.level);
        if (reqId.current === id) setDetail(d);
      } catch (e) {
        if (reqId.current === id) onError(e instanceof Error ? e.message : String(e));
      } finally {
        if (reqId.current === id) setLoading(false);
      }
    },
    [onError],
  );

  const close = useCallback(() => {
    // 推进 reqId，让在途请求的结果失效
    reqId.current += 1;
    setRequest(null);
    setDetail(null);
  }, []);

  /** 标记 / 取消标记。以 detail.card 是否存在为当前状态。 */
  const toggleMark = useCallback(async () => {
    if (!request) return;
    try {
      if (detail?.card) {
        await api.unmark(request.word);
        setDetail(await api.word(request.word, request.textId, request.level));
      } else {
        const res = await api.mark(request.word, request.textId);
        setDetail(res.detail);
      }
      await onStateChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [request, detail, onStateChange, onError]);

  /**
   * 正文里标记后同步面板：如果面板正开着同一个词，把卡片刷新成已标记。
   * @param word
   */
  const syncMarked = useCallback(
    async (word: string) => {
      if (!request || request.word !== word) return;
      try {
        setDetail(await api.word(word, request.textId, request.level));
      } catch {
        /* 同步失败不影响阅读，忽略 */
      }
    },
    [request],
  );

  return {
    request,
    detail,
    loading,
    marked: Boolean(detail?.card),
    open,
    close,
    toggleMark,
    syncMarked,
  };
}
