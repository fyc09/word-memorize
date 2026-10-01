/**
 * 后台抓取任务的轮询。
 *
 * 任务状态在服务端数据库里（jobs 表），不在内存里 ——
 * 所以刷新页面后 job.status 仍然是 running，按钮保持置灰。
 * 这里只负责「还在跑就继续问」，跑完了通知外层刷新一次状态。
 */

import { useEffect } from 'react';
import { api } from '../api';
import type { FetchJob } from '../types';

const POLL_MS = 1500;

export function useFetchJob(job: FetchJob | null | undefined, reload: () => void | Promise<void>) {
  const running = job?.status === 'running';

  useEffect(() => {
    if (!running) return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const { job: latest } = await api.fetchStatus();
          if (latest && latest.status !== 'running') await reload();
        } catch {
          /* 轮询失败不打扰用户，下一轮再试 */
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [running, reload]);

  return { running: Boolean(running) };
}
