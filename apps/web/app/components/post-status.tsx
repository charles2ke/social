import { statusMeta, type PostStatus } from "../posts";

export function StatusBadge({ status }: { status: PostStatus }) {
  const meta = statusMeta[status];
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}
