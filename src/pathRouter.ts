/**
 * DEX pathfinding router for cross-asset split payments.
 *
 * When payer and recipients use different Stellar assets, this module queries
 * Horizon's path-payment endpoints to find the best conversion route and
 * returns the optimal path for each split leg.
 *
 * Integrates with {@link SimpleCache} to avoid redundant Horizon calls for
 * identical source/destination pairs within the cache TTL window.
 */

import { Asset, Horizon, Operation } from "@stellar/stellar-sdk";
import { SimpleCache } from "./cache.js";
import { PathNotFoundError, PathRouterError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single hop in a DEX conversion path. */
export interface PathHop {
  /** Asset to send (or "native" for XLM). */
  sourceAsset: string;
  /** Asset to receive (or "native" for XLM). */
  destAsset: string;
  /** Source amount in the asset's base unit (stroops for XLM). */
  sourceAmount: bigint;
  /** Estimated destination amount in the asset's base unit. */
  destAmount: bigint;
}

/** The optimal conversion path between two assets. */
export interface PathResult {
  /** Ordered list of intermediate assets forming the conversion route. */
  path: Array<{ asset_code: string; asset_issuer: string; asset_type: string }>;
  /** Amount the destination will receive (in the destination asset's base unit). */
  destinationAmount: bigint;
  /** Amount sent from the source (in the source asset's base unit). */
  sourceAmount: bigint;
}

/** Parameters for pathfinding. */
export interface PathRequest {
  /** Asset the sender will supply. */
  sourceAsset: Asset;
  /** Amount the sender will supply (in the source asset's base unit). */
  sourceAmount: bigint;
  /** Asset the recipient should receive. */
  destinationAsset: Asset;
}

/** Configuration for {@link PathRouter}. */
export interface PathRouterConfig {
  /** Cache TTL in milliseconds. Default: 15_000 (15s). */
  ttlMs?: number;
  /** Maximum number of cached paths. Default: 5_000. */
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// PathRouter
// ---------------------------------------------------------------------------

/**
 * Finds the best DEX conversion path between two Stellar assets using
 * Horizon's strict-send / strict-receive pathfinding endpoints.
 *
 * Results are cached per (sourceAsset, destAsset, sourceAmount) triple to
 * avoid redundant Horizon queries within the TTL window.
 */
export class PathRouter {
  private readonly server: Horizon.Server;
  private readonly cache: SimpleCache<PathResult>;

  /**
   * @param horizonUrl - Horizon server URL.
   * @param config     - Optional tuning parameters.
   */
  constructor(horizonUrl: string, config: PathRouterConfig = {}) {
    this.server = new Horizon.Server(horizonUrl);
    this.cache = new SimpleCache<PathResult>({
      enabled: true,
      ttlMs: config.ttlMs ?? 15_000,
      maxEntries: config.maxEntries ?? 5_000,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Find the best path to send `sourceAmount` of `sourceAsset` and receive
   * as much of `destinationAsset` as possible.
   *
   * Uses `strictSendPaths` under the hood — the source amount is fixed and
   * the destination amount is estimated.
   */
  async findStrictSendPath(req: PathRequest): Promise<PathResult> {
    const cacheKey = this.cacheKey("send", req);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const sourceAssetType = req.sourceAsset.isNative()
        ? "native"
        : `${req.sourceAsset.getCode()}:${req.sourceAsset.getIssuer()}`;
      const destAssetType = req.destinationAsset.isNative()
        ? "native"
        : `${req.destinationAsset.getCode()}:${req.destinationAsset.getIssuer()}`;

      const records = await this.server
        .strictSendPaths(
          req.sourceAsset,
          req.sourceAmount.toString(),
          [req.destinationAsset],
        )
        .call();

      if (records.records.length === 0) {
        throw new PathNotFoundError(
          sourceAssetType,
          destAssetType,
          req.sourceAmount,
        );
      }

      // First record is the best path (highest destination amount)
      const best = records.records[0]!;

      const result: PathResult = {
        path: best.path,
        destinationAmount: BigInt(best.destination_amount),
        sourceAmount: BigInt(best.source_amount),
      };

      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      if (err instanceof PathNotFoundError) throw err;
      throw new PathRouterError(
        `Failed to find strict-send path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Find the best path to receive exactly `destAmount` of `destinationAsset`
   * while spending as little of `sourceAsset` as possible.
   *
   * Uses `strictReceivePaths` under the hood — the destination amount is
   * fixed and the source amount is estimated.
   */
  async findStrictReceivePath(
    sourceAsset: Asset,
    destAmount: bigint,
    destinationAsset: Asset,
  ): Promise<PathResult> {
    const cacheKey = this.cacheKeyReceive(sourceAsset, destAmount, destinationAsset);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const sourceAssetType = sourceAsset.isNative()
        ? "native"
        : `${sourceAsset.getCode()}:${sourceAsset.getIssuer()}`;
      const destAssetType = destinationAsset.isNative()
        ? "native"
        : `${destinationAsset.getCode()}:${destinationAsset.getIssuer()}`;

      const srcStr = sourceAsset.isNative()
        ? "native"
        : `${sourceAsset.getCode()}:${sourceAsset.getIssuer()}`;
      const dstStr = destinationAsset.isNative()
        ? "native"
        : `${destinationAsset.getCode()}:${destinationAsset.getIssuer()}`;

      const records = await this.server
        .strictReceivePaths(
          srcStr,
          destinationAsset,
          destAmount.toString(),
        )
        .call();

      if (records.records.length === 0) {
        throw new PathNotFoundError(
          sourceAssetType,
          destAssetType,
          destAmount,
        );
      }

      const best = records.records[0]!;

      const result: PathResult = {
        path: best.path,
        destinationAmount: BigInt(best.destination_amount),
        sourceAmount: BigInt(best.source_amount),
      };

      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      if (err instanceof PathNotFoundError) throw err;
      throw new PathRouterError(
        `Failed to find strict-receive path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build a path-payment strict-send operation for a known path.
   */
  buildPathPaymentStrictSend(
    sendAsset: Asset,
    sendAmount: string,
    destination: string,
    destAsset: Asset,
    destMin: string,
    path: Asset[],
  ): ReturnType<typeof Operation.pathPaymentStrictSend> {
    return Operation.pathPaymentStrictSend({
      sendAsset,
      sendAmount,
      destination,
      destAsset,
      destMin,
      path,
    });
  }

  /**
   * Build a path-payment strict-receive operation for a known path.
   */
  buildPathPaymentStrictReceive(
    sendAsset: Asset,
    sendMax: string,
    destination: string,
    destAsset: Asset,
    destAmount: string,
    path: Asset[],
  ): ReturnType<typeof Operation.pathPaymentStrictReceive> {
    return Operation.pathPaymentStrictReceive({
      sendAsset,
      sendMax,
      destination,
      destAsset,
      destAmount,
      path,
    });
  }

  /**
   * Return the underlying Horizon server for other queries.
   */
  getServer(): Horizon.Server {
    return this.server;
  }

  /**
   * Clear all cached paths.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private cacheKey(kind: "send" | "receive", req: PathRequest): string {
    const src = req.sourceAsset.isNative()
      ? "native"
      : `${req.sourceAsset.getCode()}:${req.sourceAsset.getIssuer()}`;
    const dst = req.destinationAsset.isNative()
      ? "native"
      : `${req.destinationAsset.getCode()}:${req.destinationAsset.getIssuer()}`;
    return `path:${kind}:${src}:${dst}:${req.sourceAmount.toString()}`;
  }

  private cacheKeyReceive(
    sourceAsset: Asset,
    destAmount: bigint,
    destinationAsset: Asset,
  ): string {
    const src = sourceAsset.isNative()
      ? "native"
      : `${sourceAsset.getCode()}:${sourceAsset.getIssuer()}`;
    const dst = destinationAsset.isNative()
      ? "native"
      : `${destinationAsset.getCode()}:${destinationAsset.getIssuer()}`;
    return `path:receive:${src}:${dst}:${destAmount.toString()}`;
  }
}
