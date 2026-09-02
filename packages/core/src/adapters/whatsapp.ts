import { requireEnv, type PlatformSpec } from "./base.js";
import { GRAPH_API, metaOAuth } from "./meta.js";

const DEFAULT_CONCURRENCY = 5;

/**
 * Sends to at most `limit` recipients at a time and records each outcome instead of
 * rejecting, so one bad number cannot abort the rest of the send.
 */
async function sendWithConcurrency<T, R>(items: T[], limit: number, send: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await send(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The WhatsApp Cloud API sends messages to opted-in recipients — it has no
 * broadcast "post" concept — so publishing fans the text out to the numbers in
 * WHATSAPP_RECIPIENTS.
 */
export const whatsappSpec: PlatformSpec = {
  id: "whatsapp",
  capabilities: { text: true, image: false, video: false, schedule: true, analytics: false },
  oauth: metaOAuth(["whatsapp_business_messaging", "whatsapp_business_management"]),
  async getProfile(ctx) {
    const phoneNumberId = requireEnv(ctx, "WHATSAPP_PHONE_NUMBER_ID");
    const number = await ctx.request<{ id: string; display_phone_number?: string; verified_name?: string }>(
      `${GRAPH_API}/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,
    );
    return { id: number.id, name: number.verified_name ?? number.display_phone_number ?? number.id };
  },
  async publish(ctx, post) {
    const phoneNumberId = encodeURIComponent(requireEnv(ctx, "WHATSAPP_PHONE_NUMBER_ID"));
    const recipients = requireEnv(ctx, "WHATSAPP_RECIPIENTS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!recipients.length) throw new Error("WHATSAPP_RECIPIENTS did not contain any phone numbers");
    const configured = Number(ctx.env.WHATSAPP_SEND_CONCURRENCY);
    const concurrency = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_CONCURRENCY;
    const sent = await sendWithConcurrency(recipients, concurrency, (to) =>
      ctx.request<{ messages?: { id: string }[] }>(`${GRAPH_API}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: post.text } }),
      }),
    );
    const ids = sent.flatMap((result) => (result.status === "fulfilled" ? (result.value.messages?.map((message) => message.id) ?? []) : []));
    // A partial delivery still counts as published; only a total failure is an error.
    if (!ids.length) {
      const failure = sent.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      throw new Error("WhatsApp did not return a message id");
    }
    return { platformPostId: ids[0]!, publishedAt: new Date() };
  },
};
