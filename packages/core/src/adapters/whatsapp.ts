import { requireEnv, type PlatformSpec } from "./base.js";
import { GRAPH_API, metaOAuth } from "./meta.js";

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
    const sent = await Promise.all(
      recipients.map((to) =>
        ctx.request<{ messages?: { id: string }[] }>(`${GRAPH_API}/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: post.text } }),
        }),
      ),
    );
    const ids = sent.flatMap((response) => response.messages?.map((message) => message.id) ?? []);
    if (!ids.length) throw new Error("WhatsApp did not return a message id");
    return { platformPostId: ids[0], publishedAt: new Date() };
  },
};
