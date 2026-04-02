/**
 * @file stabilize.ts
 * @description The main entry point for the Stabilize ORM, tying together the client, cache, and repositories.
 * @author ElectronSz
 */
import { Cache } from "./cache";
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
} from "./types";
import { defineModel, MetadataStorage } from "./model";
import type { Hook } from "./hooks";

export class Stabilize {
  public client: DBClient;
  private cache: Cache | null;
  private logger: Logger;
  public events: StabilizeEmitter;

  constructor(
    config: DBConfig,
    cacheConfig: CacheConfig = { enabled: false, ttl: 60 },
    loggerConfig: LoggerConfig = {},
    existingClient?: DBClient,
  ) {
    this.logger = new StabilizeLogger(loggerConfig);
    this.client = existingClient || new DBClient(config, this.logger);
    this.cache = existingClient
      ? null
      : cacheConfig.enabled
        ? new Cache(cacheConfig, this.logger)
        : null;
    this.events = new StabilizeEmitter();
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
    const cacheConfig = this.cache ? this.cache.config : undefined;
    return new Repository(this.client, model, cacheConfig, this.logger);
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
   * @returns A promise that resolves to an object containing cache hits, misses, and total keys.
   * @example
   * ```
   * const stats = await stabilize.getCacheStats();
   * console.log(`Cache Hits: ${stats.hits}, Misses: ${stats.misses}`);
   * ```
   */
  async getCacheStats(): Promise<CacheStats> {
    if (!this.cache) {
      return { hits: 0, misses: 0, keys: 0 };
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
      const results = await this.client.query("SELECT 1 AS ok");
      const cacheStatus = this.cache
        ? (await this.cache.get("healthcheck"))
          ? "connected"
          : "connected (miss)"
        : "disabled";
      return {
        status: results.length > 0 ? "healthy" : "unhealthy",
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

  async migrate(config: DBConfig, migrations: Migration[]) {
    return runMigrations(config, migrations);
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
  defineModel,
  autoMigrate,
  sqlDefault,
  defineSeed,
  runSeeds,
  resetDatabase,
  StabilizeEmitter,
  generateUUID,
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
};
