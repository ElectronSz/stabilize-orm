/**
 * @file cache.ts
 * @description Provides a Redis-backed caching layer for the ORM.
 * @author ElectronSz
 */

import Redis from "ioredis";
import { type CacheConfig, type CacheStats } from "./types";
import { StabilizeLogger, type Logger } from "./logger";

/**
 * A caching client that uses Redis to store and retrieve query results.
 * It supports cache-aside and write-through strategies and keeps track of basic stats.
 */
export class Cache {
  private redis: Redis | null = null;
  private logger: Logger;
  private hits: number = 0;
  private misses: number = 0;

  /** The configuration object the cache was initialized with. */
  public readonly config: CacheConfig;

  /**
   * Creates an instance of the Cache client.
   * @param config The configuration for the cache, including Redis URL and TTL.
   * @param logger A logger instance for logging messages.
   */
  constructor(config: CacheConfig, logger: Logger = new StabilizeLogger()) {
    this.config = config;
    this.logger = logger;

    if (this.config.enabled && this.config.redisUrl) {
      this.redis = new Redis(this.config.redisUrl, { lazyConnect: true });
      this.redis.on("error", (error) => this.logger.logError(error));
    }
  }

  /**
   * Gets the caching strategy being used.
   * @returns The caching strategy, either 'cache-aside' or 'write-through'.
   */
  getStrategy() {
    return this.config.strategy || "cache-aside";
  }

  /**
   * Retrieves an item from the cache.
   * @template T The expected type of the cached item.
   * @param key The key of the item to retrieve.
   * @returns A promise that resolves to the cached item or `null` if not found.
   * @example
   * ```
   * const user = await cache.get<User>('user:1');
   * ```
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;

    try {
      const data = await this.redis.get(this.config.cachePrefix + key);
      if (data) {
        this.hits++;
        this.logger.logDebug(`Cache hit for key: ${key}`);
        return JSON.parse(data) as T;
      }
      this.misses++;
      this.logger.logDebug(`Cache miss for key: ${key}`);
      return null;
    } catch (error) {
      this.logger.logError(error as Error);
      return null;
    }
  }

  /**
   * Stores an item in the cache.
   * @template T The type of the item being stored.
   * @param key The key to store the item under.
   * @param value The value to store.
   * @param ttl Optional: The time-to-live for this specific item in seconds. Defaults to the global TTL.
   * @returns A promise that resolves when the item is set.
   * @example
   * ```
   * await cache.set('user:1', user, 3600); // Cache for 1 hour
   * ```
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (!this.redis) return;

    try {
      const effectiveTtl = ttl ?? this.config.ttl;
      await this.redis.set(this.config.cachePrefix + key, JSON.stringify(value), "EX", effectiveTtl);
      this.logger.logDebug(`Cache set for key: ${key}`);
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  /**
   * Removes one or more items from the cache by their exact keys.
   * @param keys An array of keys to invalidate.
   * @returns A promise that resolves when the keys are invalidated.
   * @example
   * ```
   * await cache.invalidate(['user:1', 'all_users']);
   * ```
   */
  async invalidate(keys: string[]): Promise<void> {
    if (!this.redis) return;

    try {
      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.del(this.config.cachePrefix + key);
        this.logger.logDebug(`Cache invalidated for key: ${key}`);
      }
      await pipeline.exec();
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  /**
   * Invalidates all keys matching a given pattern.
   * @param pattern The pattern to match against (e.g., 'user:*').
   * @returns A promise that resolves when the operation is complete.
   * @example
   * ```
   * await cache.invalidatePattern('user:*'); // Invalidates all user-related cache
   * ```
   */
  async invalidatePattern(pattern: string): Promise<void> {
    if (!this.redis) return;

    try {
      const keys = await this.redis.keys(this.config.cachePrefix + pattern);
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.del(key);
        }
        await pipeline.exec();
        this.logger.logDebug(`Cache invalidated for pattern: ${pattern} (${keys.length} keys)`);
      }
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  /**
   * Retrieves statistics about the cache, including hits, misses, and total key count.
   * @returns A promise that resolves to a `CacheStats` object.
   * @example
   * ```
   * const stats = await cache.getStats();
   * console.log(`Cache Hits: ${stats.hits}, Misses: ${stats.misses}`);
   * ```
   */
  async getStats(): Promise<CacheStats> {
    if (!this.redis) return { hits: 0, misses: 0, keys: 0 };
    try {
      const keys = await this.redis.keys(this.config.cachePrefix + "*");
      return { hits: this.hits, misses: this.misses, keys: keys.length };
    } catch (error) {
      this.logger.logError(error as Error);
      return { hits: this.hits, misses: this.misses, keys: 0 };
    }
  }

  /**
   * Disconnects the Redis client gracefully.
   * @returns A promise that resolves when the client has disconnected.
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.logger.logInfo("Redis connection closed");
    }
  }
}