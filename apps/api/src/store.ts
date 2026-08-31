import { randomUUID } from "node:crypto";
import type { PlatformId, PostDraft } from "@social/core";
export type Draft = PostDraft & { id: string; createdAt: string };
export type Account = { id: string; platform: PlatformId; name: string; tokenExpiresAt?: string };
const drafts = new Map<string, Draft>(); const accounts = new Map<string, Account>();
export const store = {
  accounts: () => [...accounts.values()],
  addMockAccounts() { if (!accounts.size && process.env.MOCK_MODE === "true") ["instagram", "linkedin"].forEach((platform) => { const account = { id: randomUUID(), platform: platform as PlatformId, name: `Demo ${platform}`, tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }; accounts.set(account.id, account); }); return this.accounts(); },
  createDraft(draft: PostDraft) { const result = { ...draft, id: randomUUID(), createdAt: new Date().toISOString() }; drafts.set(result.id, result); return result; },
  updateDraft(id: string, draft: Partial<PostDraft>) { const old = drafts.get(id); if (!old) return undefined; const result = { ...old, ...draft }; drafts.set(id, result); return result; },
  drafts: () => [...drafts.values()]
};
