/**
 * @file stabilize.ts
 * @description The main entry point for the Stabilize ORM, tying together the client, cache, and repositories.
 * @author ElectronSz
 */
import { Cache } from "./cache";
import { StabilizeKV } from "./stabilize-kv";
import type {
  StabilizeKVOptions,
  StabilizeKVGetOptions,
  StabilizeKVPutOptions,
  StabilizeKVListOptions,
  StabilizeKVListResult,
  StabilizeKVKey,
  StabilizeKVMetadata,
  StabilizeKVValue,
} from "./stabilize-kv";
import { DBClient } from "./client";
import { type Logger, StabilizeLogger } from "./logger";
import { QueryBuilder } from "./query-builder";
import { Repository } from "./repository";
import {
  runMigrations,
  generateMigration,
  type Migration,
  mapDataTypeToSql,
} from "./migrations";
import {
  generateMongoMigration,
  rollbackMongoMigration,
  MONGO_MIGRATIONS_COLLECTION,
} from "./mongo-migrate";
import {
  autoMigrate,
  defineSeed,
  runSeeds,
  resetDatabase,
  type SeedDefinition,
} from "./auto-migrate";
import {
  type DBConfig,
  type CacheConfig,
  type LoggerConfig,
  DBType,
  DataTypes,
  StabilizeError,
  type PoolMetrics,
  type QueryHint,
  RelationType,
  type CacheStats,
  LogLevel,
  type DefaultExpression,
  sqlDefault,
  type TransactionIsolationLevel,
  type QueryLogEntry,
  type StabilizeEvent,
  type StabilizeEventHandler,
  StabilizeEmitter,
  generateUUID,
  // The two MongoDB types this package re-exports. Both are reached through
  // `types.ts`, the shared type surface: `mongo-query` and `mongo-schema` are
  // not published entry points, so neither is somewhere a consumer could name
  // them from.
  type Predicate,
  type MongoStep,
} from "./types";
import { defineModel, MetadataStorage } from "./model";
import type { Hook } from "./hooks";

export class Stabilize {
  public client: DBClient;
  private cache: Cache | null;
  private logger: Logger;
  public events: StabilizeEmitter;
  /** Repositories handed out so far, keyed by model. @see getRepository */
  private repositories = new Map<Function, Repository<any>>();

  /**
   * @param config The database configuration.
   * @param cacheConfig Cache settings. `enabled` with no `redisUrl` falls back
   *   to an in-process store. @see Cache
   * @param loggerConfig Logging settings.
   * @param existingClient A client to build on, for a caller that has one. Its
   *   emitter is adopted, so events still arrive here.
   * @param events An emitter to use instead of a fresh one. This is the only
   *   way to hear `connection:open`: it fires from this constructor, before a
   *   handler registered on `this.events` afterwards could exist. Build the
   *   emitter, subscribe, then pass it.
   */
  constructor(
    config: DBConfig,
    cacheConfig: CacheConfig = { enabled: false, ttl: 60 },
    loggerConfig: LoggerConfig = {},
    existingClient?: DBClient,
    events?: StabilizeEmitter,
  ) {
    this.logger = new StabilizeLogger(loggerConfig);
    // Built before the client, because the client is handed this emitter: every
    // `query`, `error` and `transaction:*` the client fires has to reach a
    // handler registered here. Each side owning its own emitter meant an `on`
    // call on the ORM heard only the two connection events.
    this.events = events ?? new StabilizeEmitter();
    // A client handed in from outside was built before this instance existed
    // and may be shared with another one, so it is told to use this emitter
    // rather than assumed to have it.
    this.client = existingClient || new DBClient(
      config,
      this.logger,
      null,
      null,
      this.events,
    );
    if (existingClient) this.client.useEmitter(this.events);
    this.cache = existingClient
      ? null
      : cacheConfig.enabled
        ? new Cache(cacheConfig, this.logger)
        : null;
    this.events.emit("connection:open", config.type);
  }

  /**
   * Gets a repository for a given model, used to perform CRUD operations.
   * @param model The model class, defined using `defineModel`.
   * @returns A new `Repository` instance for the specified model.
   * @example
   * ```
   * const stabilize = new Stabilize(dbConfig);
   * const userRepository = stabilize.getRepository(User);
   *
   * const user = await userRepository.findOne(1);
   * console.log(user);
   * ```
   */
  getRepository<T>(model: new (...args: any[]) => T): Repository<T> {
    // Memoised per model. Every Repository owns an optional cache handle, so
    // building a new one on each call opened a second Redis connection that
    // nothing disconnected and that `getCacheStats()` never saw — it reports on
    // the ORM's own cache, which no repository was using.
    const existing = this.repositories.get(model);
    if (existing) return existing as Repository<T>;

    const repository = new Repository(
      this.client,
      model,
      this.cache?.config,
      this.logger,
      this.cache,
    );
    this.repositories.set(model, repository);
    return repository;
  }

  /**
   * Executes a callback within a database transaction, ensuring all operations are atomic.
   * The callback receives a transactional `DBClient` instance that must be passed to
   * repository methods to ensure they are part of the same transaction.
   *
   * @param callback The async function to execute. It receives a `txClient` as its only argument.
   * @returns The result of the callback function.
   * @example
   * ```
   * const userRepo = stabilize.getRepository(User);
   * const profileRepo = stabilize.getRepository(Profile);
   *
   * try {
   *   await stabilize.transaction(async (txClient) => {
   *     const newUser = await userRepo.create({ name: 'Ciniso Dlamini' }, {}, txClient);
   *     await profileRepo.create({ userId: newUser.id, bio: 'A new bio' }, {}, txClient);
   *   });
   *   console.log('User and profile created successfully.');
   * } catch (error) {
   *   console.error('Transaction failed, everything was rolled back.', error);
   * }
   * ```
   */
  async transaction<T>(
    callback: (txClient: DBClient) => Promise<T>,
  ): Promise<T> {
    return this.client.transaction(callback);
  }

  /**
   * Retrieves statistics from the cache, if it is enabled.
   *
   * `backend` is reported alongside the counters because the two are easy to
   * confuse: `enabled: true` with no reachable Redis used to produce a cache
   * that answered every call with a miss and reported zeros forever, and
   * nothing in the return value distinguished that from a cold cache.
   *
   * @returns A promise that resolves to a `CacheStats` object: hits, misses,
   *   total keys, and which store answered — `"redis"`, `"memory"` or
   *   `"disabled"`. `"redis"` reports the configuration, not the connection,
   *   which `ioredis` opens lazily.
   * @example
   * ```
   * const stats = await stabilize.getCacheStats();
   * console.log(`Cache Hits: ${stats.hits}, Misses: ${stats.misses}`);
   * ```
   */
  async getCacheStats(): Promise<CacheStats> {
    if (!this.cache) {
      return { hits: 0, misses: 0, keys: 0, backend: "disabled" };
    }
    return this.cache.getStats();
  }

  /**
   * Closes the database connection and disconnects the cache client for a graceful shutdown.
   * @example
   * ```
   * await stabilize.close();
   * console.log('Connections closed.');
   * ```
   */
  async close() {
    this.events.emit("connection:close");
    await this.client.close();
    if (this.cache) {
      await this.cache.disconnect();
    }
  }

  async healthCheck(): Promise<{
    status: string;
    database: string;
    latencyMs: number;
    cacheStatus: string;
  }> {
    const start = performance.now();
    try {
      // MongoDB has no `SELECT 1`; `ping` is its equivalent liveness command.
      // Both are wrapped the same way so a slow or unreachable server lands in
      // the same catch rather than escaping as a different error shape.
      const isMongo = this.client.config.type === DBType.MongoDB;
      const healthy = isMongo
        ? (await this.client.mongoCommand({ ping: 1 })).ok === 1
        : (await this.client.query("SELECT 1 AS ok")).length > 0;

      // The backend is named rather than reduced to connected-or-not: an
      // in-process cache has no connection to report, and calling it
      // "connected" said nothing while looking like an answer. `"redis"` here
      // still means "configured", not "reachable" — `ioredis` connects lazily,
      // and a failed round trip surfaces in the catch below as `"unknown"`.
      const backend = this.cache?.backend ?? "disabled";
      const cacheStatus =
        backend === "disabled"
          ? "disabled"
          : backend === "memory"
            ? "in-memory"
            : (await this.cache!.get("healthcheck"))
              ? "connected"
              : "connected (miss)";
      return {
        status: healthy ? "healthy" : "unhealthy",
        database: this.client.config.type,
        latencyMs: Number((performance.now() - start).toFixed(2)),
        cacheStatus,
      };
    } catch (error) {
      return {
        status: "unhealthy",
        database: this.client.config.type,
        latencyMs: Number((performance.now() - start).toFixed(2)),
        cacheStatus: "unknown",
      };
    }
  }

  async rawQuery<T = any>(query: string, params: any[] = []): Promise<T[]> {
    return this.client.query<T>(query, params);
  }

  async rawExec(
    query: string,
    params: any[] = [],
  ): Promise<{ affectedRows: number }> {
    return this.client.queryExec(query, params);
  }

  /**
   * Applies pending migrations against `config`.
   *
   * The ORM's own emitter is handed to the runner, so `migration:start`,
   * `migration:complete` and the `query` and `transaction:*` events a step
   * raises all arrive at handlers registered here — not on a second, private
   * emitter belonging to the connection the runner opens for itself.
   */
  async migrate(config: DBConfig, migrations: Migration[]) {
    return runMigrations(config, migrations, this.events);
  }

  async autoMigrate(models: any | any[]) {
    return autoMigrate(this.client, models);
  }

  async seed(seeds?: any[]) {
    if (seeds) {
      return runSeeds(this.client, seeds);
    }
    return runSeeds(this.client);
  }

  async reset(models: any | any[]) {
    return resetDatabase(this.client, models);
  }

  async poolStats(): Promise<{ active: number; idle: number; total: number }> {
    const raw = this.client as any;
    if (raw.totalCount !== undefined) {
      return { active: 0, idle: 0, total: raw.totalCount };
    }
    if (raw._allConnections && raw._allConnections.length !== undefined) {
      return {
        active: raw._allConnections.length,
        idle: raw._freeConnections?.length ?? 0,
        total: raw._allConnections.length,
      };
    }
    // `Stabilize.client` is the DBClient wrapper, so the driver's pool is one
    // level down. Only the SQL Server branch below reads through it; the two
    // checks above are left reading `raw` exactly as they always have.
    const pool = raw.client ?? raw;
    if (
      this.client.config.type === DBType.MSSQL &&
      typeof pool?.size === "number"
    ) {
      return {
        active: pool.borrowed ?? 0,
        idle: pool.available ?? 0,
        total: pool.size ?? 0,
      };
    }
    // MongoDB and SQLite land here deliberately. Neither exposes a pool whose
    // occupancy can be read synchronously — the mongo driver's pool is internal
    // and per-server, and SQLite has no pool at all — so the sentinel is the
    // honest answer rather than a number invented to fill the shape.
    return { active: -1, idle: -1, total: -1 };
  }
}

export {
  Repository,
  DBClient,
  QueryBuilder,
  Cache,
  StabilizeLogger,
  DBType,
  DataTypes,
  LogLevel,
  RelationType,
  MetadataStorage,
  mapDataTypeToSql,
  StabilizeError,
  runMigrations,
  generateMigration,
  // The MongoDB migration surface. Exported because a migration's Mongo half
  // rides in `mongoUp`/`mongoDown` rather than in `up`/`down`, so a caller that
  // generates migrations itself — the CLI does — has no other way to reach it,
  // and because the ledger's collection name has to agree with the one
  // `runMongoMigrations` writes to.
  generateMongoMigration,
  rollbackMongoMigration,
  MONGO_MIGRATIONS_COLLECTION,
  defineModel,
  autoMigrate,
  sqlDefault,
  defineSeed,
  runSeeds,
  resetDatabase,
  StabilizeEmitter,
  generateUUID,
  // The in-process store behind a Cache with no `redisUrl`. Exported because
  // it is useful on its own — as a key-value store for a single-process app's
  // own data, or as a test double for code that expects Workers KV, whose API
  // it follows — and because a caller choosing the memory backend should be
  // able to read its `maxEntries` and expiry rules rather than infer them.
  StabilizeKV,
};

export type {
  Migration,
  DBConfig,
  CacheConfig,
  LoggerConfig,
  QueryHint,
  PoolMetrics,
  CacheStats,
  Logger,
  Hook,
  DefaultExpression,
  SeedDefinition,
  TransactionIsolationLevel,
  QueryLogEntry,
  StabilizeEvent,
  StabilizeEventHandler,
  // The two MongoDB types a consumer can legitimately need to name: the
  // predicate the query builder records, and the serializable migration step.
  // Both are reached through `types.ts`, the shared type surface, rather than
  // through `mongo-query`/`mongo-schema` — neither of which is a published
  // entry point.
  Predicate,
  MongoStep,
  // The shapes a StabilizeKV caller names directly: the two option bags, a key as
  // `list` reports it, and a page of them.
  StabilizeKVOptions,
  StabilizeKVGetOptions,
  StabilizeKVPutOptions,
  StabilizeKVListOptions,
  StabilizeKVListResult,
  StabilizeKVKey,
  StabilizeKVMetadata,
  StabilizeKVValue,
};
