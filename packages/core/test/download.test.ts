import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAdapters, DownloadError, downloadMedia, isPublicAddress, type Downloader } from "../src/index.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** A local server; tests widen `isAllowedAddress` to reach it, since loopback is blocked by default. */
async function serve(handler: Parameters<typeof createServer>[1]) {
  const hits: string[] = [];
  server = createServer((request, response) => { hits.push(request.url ?? ""); handler!(request, response); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}
const onlyLoopback = (address: string) => address === "127.0.0.1";

describe("isPublicAddress", () => {
  it("allows public unicast addresses", () => {
    for (const address of ["8.8.8.8", "151.101.1.69", "2606:4700:4700::1111"]) expect(isPublicAddress(address)).toBe(true);
  });
  it("blocks loopback, private, link-local, CGNAT, reserved and IPv4-embedding addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "not-an-ip"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("downloadMedia", () => {
  it("refuses a cloud metadata IP without connecting", async () => {
    await expect(downloadMedia("http://169.254.169.254/latest/meta-data/", { maxBytes: 1024 })).rejects.toThrow(/private or reserved/);
    await expect(downloadMedia("http://[::ffff:169.254.169.254]/", { maxBytes: 1024 })).rejects.toThrow(DownloadError);
  });

  it("refuses a hostname that resolves to a loopback address", async () => {
    const { base, hits } = await serve((_request, response) => response.end("secret"));
    await expect(downloadMedia(base.replace("127.0.0.1", "localhost"), { maxBytes: 1024 })).rejects.toThrow(/private or reserved/);
    expect(hits).toEqual([]);
  });

  it("returns the body and content type from an allowed address", async () => {
    const { base } = await serve((_request, response) => { response.setHeader("content-type", "video/mp4"); response.end("video-bytes"); });
    const media = await downloadMedia(`${base}/clip.mp4`, { maxBytes: 1024, isAllowedAddress: onlyLoopback });
    expect(Buffer.from(media.bytes).toString()).toBe("video-bytes");
    expect(media.contentType).toBe("video/mp4");
  });

  it("stops at the size limit whether or not the length is declared", async () => {
    const { base } = await serve((request, response) => {
      if (request.url === "/declared") response.setHeader("content-length", "4096");
      response.end("x".repeat(4096));
    });
    await expect(downloadMedia(`${base}/declared`, { maxBytes: 1024, isAllowedAddress: onlyLoopback })).rejects.toThrow(/1024-byte download limit/);
    await expect(downloadMedia(`${base}/chunked`, { maxBytes: 1024, isAllowedAddress: onlyLoopback })).rejects.toThrow(/1024-byte download limit/);
  });

  it("re-checks every redirect hop and bounds the redirect count", async () => {
    const { base } = await serve((request, response) => {
      response.statusCode = 302;
      response.setHeader("location", request.url === "/to-private" ? "http://10.0.0.1/clip.mp4" : "/loop");
      response.end();
    });
    await expect(downloadMedia(`${base}/to-private`, { maxBytes: 1024, isAllowedAddress: onlyLoopback })).rejects.toThrow(/10\.0\.0\.1: it is a private or reserved address/);
    await expect(downloadMedia(`${base}/loop`, { maxBytes: 1024, isAllowedAddress: onlyLoopback, maxRedirects: 2 })).rejects.toThrow(/more than 2 redirects/);
  });

  it.each(["redirect", "missing-location", "error"])("closes a discarded %s response without draining its body", async (kind) => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const { base } = await serve((request, response) => {
      if (request.url === "/final") {
        response.end("ok");
        return;
      }
      response.statusCode = kind === "error" ? 500 : 302;
      if (kind === "redirect") response.setHeader("location", "/final");
      response.write("first chunk");
      const interval = setInterval(() => response.write("more"), 10);
      response.on("close", () => { clearInterval(interval); closed(); });
    });
    try {
      const download = downloadMedia(base, { maxBytes: 1024, timeoutMs: 2_000, isAllowedAddress: onlyLoopback });
      if (kind === "redirect") {
        expect(Buffer.from((await download).bytes).toString()).toBe("ok");
      } else {
        await expect(download).rejects.toThrow(kind === "error" ? /status 500/ : /no location/);
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([disconnected, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("discarded response was not closed")), 1_000);
        })]);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      server?.closeAllConnections();
    }
  });

  it("only downloads over http(s)", async () => {
    await expect(downloadMedia("file:///etc/passwd", { maxBytes: 1024 })).rejects.toThrow(/http\(s\)/);
  });
});

describe("YouTube uploads", () => {
  const youtubeEnv = { MOCK_MODE: "false", MEDIA_MAX_DOWNLOAD_BYTES: "2048" };
  const post = { text: "Title\nDescription", media: [{ url: "https://cdn.example/clip.mp4", kind: "video" as const }] };

  function stubUpload() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(null, { status: 200, headers: { location: "https://upload.example/session" } })
        : new Response(JSON.stringify({ id: "vid-1" }), { status: 200 });
    };
    return { calls, doFetch };
  }

  it("uploads the guarded download with the configured size cap", async () => {
    const { calls, doFetch } = stubUpload();
    const requested: { url: string; maxBytes: number }[] = [];
    const download: Downloader = async (url, options) => { requested.push({ url, maxBytes: options.maxBytes }); return { bytes: new Uint8Array([1, 2, 3]), contentType: "video/mp4" }; };
    const result = await createAdapters({ env: youtubeEnv, fetch: doFetch, download }).youtube.publish({ accessToken: "t" }, post);
    expect(requested).toEqual([{ url: "https://cdn.example/clip.mp4", maxBytes: 2048 }]);
    expect(calls[1]!.init?.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.platformPostId).toBe("vid-1");
  });

  it("does not open an upload session for media that is not a video", async () => {
    const { calls, doFetch } = stubUpload();
    const download: Downloader = async () => ({ bytes: new Uint8Array([1]), contentType: "text/plain" });
    await expect(createAdapters({ env: youtubeEnv, fetch: doFetch, download }).youtube.publish({ accessToken: "t" }, post)).rejects.toThrow(/not a video/);
    expect(calls).toHaveLength(0);
  });
});
