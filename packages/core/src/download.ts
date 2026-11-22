import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Addresses a server-side download must never reach: loopback, private,
 * link-local (cloud metadata endpoints), CGNAT, documentation, multicast and
 * reserved ranges, plus IPv6 forms that embed an IPv4 address. The families
 * live in separate lists because a BlockList checks IPv4 addresses against
 * IPv6 rules too, and `::ffff:0:0/96` would then match every IPv4 address.
 */
const reservedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) reservedV4.addSubnet(network, prefix, "ipv4");
const reservedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) reservedV6.addSubnet(network, prefix, "ipv6");

/** True only for a publicly routable unicast IP address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  try {
    return family === 4 ? !reservedV4.check(address, "ipv4") : !reservedV6.check(address, "ipv6");
  } catch {
    return false;
  }
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export type DownloadOptions = {
  maxBytes: number;
  maxRedirects?: number;
  /** Socket inactivity timeout, so a stalled server can't hold a publish forever. */
  timeoutMs?: number;
  /** Which resolved addresses may be contacted; defaults to public addresses only. */
  isAllowedAddress?: (address: string) => boolean;
};
export type DownloadedMedia = { bytes: Uint8Array; contentType?: string };
export type Downloader = (url: string, options: DownloadOptions) => Promise<DownloadedMedia>;

/**
 * Resolves like `dns.lookup` but refuses hostnames with any disallowed
 * address. The socket connects to the address checked here, so a DNS answer
 * that changes between check and connect (rebinding) can't slip through.
 */
function guardedLookup(isAllowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, "", 0);
      const first = addresses[0];
      if (!first || addresses.some(({ address }) => !isAllowed(address))) {
        return callback(new DownloadError(`Refusing to download media from ${hostname}: it resolves to a private or reserved address`), "", 0);
      }
      if (options.all) return callback(null, addresses);
      return callback(null, first.address, first.family);
    });
  };
}

function get(url: URL, lookup: LookupFunction, timeoutMs: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, { lookup, headers: { Accept: "video/*, image/*;q=0.9, */*;q=0.1" } }, resolve);
    request.setTimeout(timeoutMs, () => request.destroy(new DownloadError(`Media download stalled for ${timeoutMs} ms`)));
    request.on("error", reject);
  });
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/**
 * Downloads media a post links to, for platforms that need the bytes uploaded
 * rather than a URL. The URL comes from post content, so the download is
 * restricted to public addresses (no SSRF into the host's network or a cloud
 * metadata endpoint), every redirect hop is re-checked, and the body is capped
 * at `maxBytes` instead of being buffered without limit.
 */
export async function downloadMedia(url: string, options: DownloadOptions): Promise<DownloadedMedia> {
  const { maxBytes, maxRedirects = 3, timeoutMs = 30_000, isAllowedAddress = isPublicAddress } = options;
  const lookup = guardedLookup(isAllowedAddress);
  let current: URL;
  try { current = new URL(url); } catch { throw new DownloadError("Media URL is not a valid URL"); }
  for (let redirects = 0; ; redirects += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new DownloadError("Media can only be downloaded over http(s)");
    if (current.username || current.password) throw new DownloadError("Media URLs must not contain credentials");
    const host = current.hostname.replace(/^\[|\]$/g, "");
    // Node connects to IP literals without calling `lookup`, so they are checked here.
    if (isIP(host) && !isAllowedAddress(host)) throw new DownloadError(`Refusing to download media from ${host}: it is a private or reserved address`);

    const response = await get(current, lookup, timeoutMs);
    const status = response.statusCode ?? 0;
    if (redirectStatuses.has(status)) {
      response.resume();
      const location = response.headers.location;
      if (!location) throw new DownloadError(`Media download redirect (status ${status}) had no location`);
      if (redirects >= maxRedirects) throw new DownloadError(`Media download followed more than ${maxRedirects} redirects`);
      current = new URL(location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new DownloadError(`Could not download the media (status ${status})`);
    }
    const tooLarge = () => {
      response.destroy();
      return new DownloadError(`Media is larger than the ${maxBytes}-byte download limit`);
    };
    if (Number(response.headers["content-length"]) > maxBytes) throw tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks, size), contentType: response.headers["content-type"] };
  }
}
