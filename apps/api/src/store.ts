import { randomUUID } from "node:crypto";
import type { PostDraft } from "@social/core";
export type Draft = PostDraft & { id: string; createdAt: string };
const drafts = new Map<string, Draft>();
export const store = {
  createDraft(draft: PostDraft) { const result = { ...draft, id: randomUUID(), createdAt: new Date().toISOString() }; drafts.set(result.id, result); return result; },
  updateDraft(id: string, draft: Partial<PostDraft>) { const old = drafts.get(id); if (!old) return undefined; const result = { ...old, ...draft }; drafts.set(id, result); return result; },
  drafts: () => [...drafts.values()]
};
