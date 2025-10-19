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
import { runMigrations, generateMigration, type Migration, mapDataTypeToSql} from "./migrations";
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
} from "./types";
import { defineModel, MetadataStorage } from "./model";
import type { Hook } from "./hooks";

export class Stabilize {
  public client: DBClient;
  private cache: Cache | null;
  private logger: Logger;

  /**
   * Creates an instance of the Stabilize ORM.
   * @param config The database configuration object.
   * @param cacheConfig Optional configuration for the cache. Caching is disabled if not provided.
   * @param loggerConfig Optional configuration for the logger.
   */
  constructor(
    config: DBConfig,
    cacheConfig: CacheConfig = { enabled: false, ttl: 60 },
    loggerConfig: LoggerConfig = {},
    existingClient?: DBClient,
  ) {
    this.logger = new StabilizeLogger(loggerConfig);
    this.client = existingClient || new DBClient(config, this.logger);
    this.cache = existingClient ? null : (cacheConfig.enabled
      ? new Cache(cacheConfig, this.logger)
      : null);
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
  async transaction<T>(callback: (txClient: DBClient) => Promise<T>): Promise<T> {
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
    await this.client.close();
    if (this.cache) {
      await this.cache.disconnect();
    }
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
  Hook
};
