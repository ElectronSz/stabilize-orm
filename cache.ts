/**
 * @file cache.ts
 * @description Provides the ORM's caching layer, over Redis or in process.
 * @author ElectronSz
 */

import Redis from "ioredis";
import { type CacheConfig, type CacheStats } from "./types";
import { StabilizeLogger, type Logger } from "./logger";
import { StabilizeKV } from "./stabilize-kv";

/**
 * What `Cache` needs from a store, with the differences between the two
 * backends flattened out.
 *
 * Written as an interface rather than as a branch in each of the six public
 * methods, because the branch version is how the two backends drift: the
 * in-process one ends up missing whatever was added to the Redis one last.
 * `redis` and `memory` below are the only two implementations, and every
 * public method is written once against this.
 */
interface CacheStore {
  /** The stored text at `key`, or `null`. Never throws; failures are logged. */
  read(key: string): Promise<string | null>;
  /** Stores `text` under `key` for `ttlSeconds`. Never throws. */
  write(key: string, text: string, ttlSeconds: number): Promise<void>;
  /** Removes keys. Never throws. */
  remove(keys: string[]): Promise<void>;
  /** Every key matching a Redis-style glob. Never throws; `[]` on failure. */
  scan(pattern: string): Promise<string[]>;
  /** How many keys match a glob. Never throws; `0` on failure. */
  count(pattern: string): Promise<number>;
  /** Releases the underlying connection, if there is one. */
  close(): Promise<void>;
}

/**
 * A caching client that stores query results, over Redis when a `redisUrl` is
 * given and in process when it is not.
 *
 * It supports cache-aside and write-through strategies and keeps track of basic
 * stats.
 *
 * **The in-process backend is per process.** It is not shared between
 * instances, not replicated, and gone when the process exits; two application
 * servers caching the same key will each hold their own copy and invalidating
 * on one will not invalidate the other. That is the trade for having no Redis
 * to run, and it is the right one for a single-process app, a test suite, and
 * local development — not for a fleet. Pass `redisUrl` when the cache has to be
 * shared. @see Cache.backend for how to tell which is in use at runtime.
 */
export class Cache {
  private store: CacheStore | null = null;
  private logger: Logger;
  private hits: number = 0;
  private misses: number = 0;

  /** The configuration object the cache was initialized with. */
  public readonly config: CacheConfig;

  /**
   * Creates an instance of the Cache client.
   *
   * `enabled: true` always produces a working cache, with or without a
   * `redisUrl`. It used to produce a `Cache` holding no client at all, whose
   * every method returned early: `get` answered `null`, `set` discarded its
   * value, `getStats` reported zeros forever, and nothing was logged. The
   * configuration said caching was on and nothing contradicted it.
   *
   * @param config The configuration for the cache, including Redis URL and TTL.
   * @param logger A logger instance for logging messages.
   */
  constructor(config: CacheConfig, logger: Logger = new StabilizeLogger()) {
    this.config = {
      ...config,
      cachePrefix: config.cachePrefix || "",
    };
    this.logger = logger;

    if (!this.config.enabled) {
      return;
    }

    if (this.config.redisUrl) {
      const redis = new Redis(this.config.redisUrl, { lazyConnect: true });
      redis.on("error", (error) => this.logger.logError(error));
      this.store = new RedisStore(redis, this.logger, this.config.cachePrefix!);
    } else {
      this.store = new MemoryStore(
        new StabilizeKV({ maxEntries: config.maxEntries }),
        this.logger,
        this.config.cachePrefix!,
      );
    }
  }

  /**
   * Which store is backing this cache.
   *
   * `"disabled"` means `enabled` was false and every call is a no-op by
   * request. `"memory"` means no `redisUrl` was given: the cache works, but
   * only inside this process. `"redis"` means a Redis client was built — note
   * that this reports the configuration, not the connection, which
   * `ioredis` opens lazily and may fail to open later.
   *
   * @returns `"redis"`, `"memory"` or `"disabled"`.
   */
  get backend(): "redis" | "memory" | "disabled" {
    if (this.store instanceof RedisStore) return "redis";
    if (this.store instanceof MemoryStore) return "memory";
    return "disabled";
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
    if (!this.store) return null;

    const data = await this.store.read(this.prefixed(key));
    if (data !== null) {
      // Parsed rather than assumed. A key can hold something this cache did
      // not write — another application sharing the prefix, a value left by a
      // previous version of the model — and one unreadable entry must not turn
      // every read of that key into a thrown error. It counts as a miss,
      // because a value that cannot be returned was not a hit.
      try {
        const value = JSON.parse(data) as T;
        this.hits++;
        this.logger.logDebug(`Cache hit for key: ${key}`);
        return value;
      } catch (error) {
        this.logger.logError(error as Error);
        this.misses++;
        return null;
      }
    }

    this.misses++;
    this.logger.logDebug(`Cache miss for key: ${key}`);
    return null;
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
    if (!this.store) return;

    const effectiveTtl = ttl ?? this.config.ttl;
    await this.store.write(
      this.prefixed(key),
      JSON.stringify(value),
      effectiveTtl,
    );
    this.logger.logDebug(`Cache set for key: ${key}`);
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
    if (!this.store) return;

    await this.store.remove(keys.map((key) => this.prefixed(key)));
    for (const key of keys) {
      this.logger.logDebug(`Cache invalidated for key: ${key}`);
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
    if (!this.store) return;

    const keys = await this.store.scan(this.prefixed(pattern));
    if (keys.length === 0) return;

    await this.store.remove(keys);
    this.logger.logDebug(
      `Cache invalidated for pattern: ${pattern} (${keys.length} keys)`,
    );
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
    const base = {
      hits: this.hits,
      misses: this.misses,
      backend: this.backend,
    };
    if (!this.store) return { ...base, keys: 0 };
    return { ...base, keys: await this.store.count(this.prefixed("*")) };
  }

  /**
   * Disconnects the Redis client gracefully, or drops the in-process store.
   * @returns A promise that resolves when the client has disconnected.
   */
  async disconnect(): Promise<void> {
    if (!this.store) return;
    await this.store.close();
    this.store = null;
  }

  /** Applies the configured prefix, which is `""` when none was given. */
  private prefixed(key: string): string {
    return (this.config.cachePrefix || "") + key;
  }
}

/**
 * A `CacheStore` over a Redis client.
 *
 * Every method catches and logs: a cache is an optimisation, and a Redis
 * outage has to degrade to a miss rather than fail the query it was
 * accelerating.
 */
class RedisStore implements CacheStore {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly prefix: string,
  ) {}

  async read(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.logger.logError(error as Error);
      return null;
    }
  }

  async write(key: string, text: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, text, "EX", ttlSeconds);
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const key of keys) pipeline.del(key);
      await pipeline.exec();
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  async scan(pattern: string): Promise<string[]> {
    try {
      return await this.redis.keys(pattern);
    } catch (error) {
      this.logger.logError(error as Error);
      return [];
    }
  }

  async count(pattern: string): Promise<number> {
    return (await this.scan(pattern)).length;
  }

  async close(): Promise<void> {
    await this.redis.quit();
    this.logger.logInfo("Redis connection closed");
  }
}

/**
 * A `CacheStore` over an in-process {@link StabilizeKV}.
 *
 * Values are stored as the JSON text `Cache` produces, not as live objects, so
 * that swapping backends cannot change what a `get` returns — a `Date` becomes
 * a string here exactly as it does through Redis, and a caller who mutates a
 * returned object cannot reach into the cache and corrupt it.
 */
class MemoryStore implements CacheStore {
  constructor(
    private readonly kv: StabilizeKV,
    private readonly logger: Logger,
    private readonly prefix: string,
  ) {}

  async read(key: string): Promise<string | null> {
    try {
      // Read as text rather than `type: "json"`: `Cache.get` parses, and a
      // parse failure there should surface as a rejected promise rather than a
      // thrown `CACHE_ERROR` from inside the store.
      return await this.kv.get<string>(key, { type: "text" });
    } catch (error) {
      this.logger.logError(error as Error);
      return null;
    }
  }

  async write(key: string, text: string, ttlSeconds: number): Promise<void> {
    try {
      // Redis expires with `EX`, which takes seconds and treats a non-positive
      // value as "delete the key". Matching that here keeps a bad TTL behaving
      // the same way on both backends instead of throwing on one.
      if (ttlSeconds <= 0) {
        await this.kv.delete(key);
        return;
      }
      await this.kv.put(key, text, { expirationTtl: ttlSeconds });
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.kv.delete(key);
    }
  }

  async scan(pattern: string): Promise<string[]> {
    try {
      // The pattern is already prefixed by the caller, and `StabilizeKV.keys`
      // matches a full Redis-style glob — `user:*`, `?`, `[a-z]` — rather than
      // approximating it with a prefix test, so nothing is narrowed here.
      return await this.kv.keys(pattern);
    } catch (error) {
      this.logger.logError(error as Error);
      return [];
    }
  }

  async count(pattern: string): Promise<number> {
    return (await this.scan(pattern)).length;
  }

  async close(): Promise<void> {
    this.kv.clear();
    this.logger.logInfo("In-memory cache cleared");
  }
}
