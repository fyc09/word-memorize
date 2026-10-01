import { useEffect, useState } from 'react';

/**
 * 延迟显示加载态。
 *
 * 本地 SQLite 查询常在 100ms 内返回 —— 直接闪一下加载动画反而比不显示更烦，
 * 尤其是搜索框「输入即搜」的场景：每敲一个键都会闪一次。
 *
 * 这里的取舍是：**真的等久了才显示**。所以「加载中」这个信号只在有意义时出现，
 * 快查询就直接把结果摆出来（结果到位本身还会播一次进场动画）。
 *
 * @param active 是否正在加载
 * @param delay  超过多久才显示，默认 180ms
 */
export function useDelayedFlag(active: boolean, delay = 180) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);

  return shown;
}
