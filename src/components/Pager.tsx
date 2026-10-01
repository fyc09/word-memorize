/**
 * 分页控件。
 *
 * 所有列表都用分页，不用「加载更多」—— 加载更多会让「一共有多少」
 * 变成未知，也没法跳回去找之前看到的东西。
 */

interface Props {
  total: number;
  offset: number;
  limit: number;
  onChange: (offset: number) => void;
}

export function Pager({ total, offset, limit, onChange }: Props) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.floor(offset / limit) + 1;
  // 只有一页时不必占位置
  if (total <= limit) return null;

  const go = (p: number) => onChange(Math.min(Math.max(p, 1), pages) * limit - limit);

  return (
    <div className="pager">
      <button className="btn btn-xs" disabled={page <= 1} onClick={() => go(page - 1)}>
        上一页
      </button>
      <span className="pager-info">
        {page} / {pages}
        <span className="muted"> 共 {total}</span>
      </span>
      <button className="btn btn-xs" disabled={page >= pages} onClick={() => go(page + 1)}>
        下一页
      </button>
    </div>
  );
}
