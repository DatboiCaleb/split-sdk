import { NetworkPassphraseValidator } from "./NetworkPassphraseValidator";
import { PassphraseMismatchError } from "../errors";

export class NetworkSwitcher {
  /**
   * Switches the network and clears all SDK state to prevent data leakage between networks.
   */
  static async switchTo(
    network: 'mainnet' | 'testnet' | 'futurenet',
    client: any // Using any here to avoid circular dependency with SplitClient
  ): Promise<void> {
    try {
      client.emit('network:switching', { network });

      // 1. Drain subscriptions
      if (client.subscriptionManager) {
        client.subscriptionManager.stopAll();
      }

      // 2. Clear all caches (As required by AC)
      if (client.cache) {
        client.cache.clear(); // Response cache
      }
      if (client.contractPool) {
        client.contractPool.clear(); // Contract pool cache
      }
      if (client.federationCache) {
        client.federationCache.clear();
      }

      // 3. Update configuration
      const config = client.options.networks[network];
      if (!config) throw new Error(`Configuration for ${network} missing.`);

      client.rpcUrl = config.rpcUrl;
      client.networkPassphrase = config.networkPassphrase;

      // 4. Re-initialize RPC Connection
      client.reinitializeRpc();

      // 5. Re-subscribe
      if (client.subscriptionManager) {
        await client.subscriptionManager.resubscribeAll();
      }

      client.emit('network:switched', { network, rpcUrl: client.rpcUrl });
    } catch (error) {
      client.emit('network:switchFailed', { network, error });
      throw error;
    }
  }
}
