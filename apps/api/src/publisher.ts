import { ConfigurationError, adapters, type PlatformId, type PostDraft, type PublishResult, type TokenSet } from "@social/core";
import { authorizedToken, type AccountRepository, type ConnectedAccount } from "./accounts.js";

export type Publisher = {
  /** The connected account a platform publishes as, if any. */
  accountFor(platform: PlatformId): Promise<ConnectedAccount | undefined>;
  tokenFor(platform: PlatformId): Promise<TokenSet>;
  publish(platform: PlatformId, draft: PostDraft): Promise<PublishResult>;
};

/**
 * Resolves credentials and publishes through the platform adapters. Shared by
 * the HTTP API (immediate publishing) and the scheduler worker, so both apply
 * the same token refresh and mock-mode behaviour.
 */
export function createPublisher(repository: AccountRepository, options: { mockMode: boolean }): Publisher {
  const accountFor = (platform: PlatformId) => repository.findByPlatform(platform);

  const tokenFor = async (platform: PlatformId): Promise<TokenSet> => {
    const account = await accountFor(platform);
    if (account) return authorizedToken(repository, account, (token) => adapters[platform].refreshToken(token));
    if (options.mockMode) return { accessToken: "mock", externalId: `mock-${platform}` };
    throw new ConfigurationError(platform, `a connected account — visit /api/oauth/${platform}/start`);
  };

  return {
    accountFor,
    tokenFor,
    publish: async (platform, draft) => adapters[platform].publish(await tokenFor(platform), draft),
  };
}
