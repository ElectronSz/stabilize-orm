import { Cache } from "./cache";
import { DBClient } from "./client";
import { type Logger, ConsoleLogger } from "./logger";
import { QueryBuilder } from "./query-builder";
import { Repository } from "./repository";
import { runMigrations, generateMigration, type Migration } from "./migrations";
import {
  Model,
  Column,
  Required,
  Unique,
  SoftDelete,
  OneToOne,
  ManyToOne,
  OneToMany,
  ManyToMany,
  ModelKey,
  ColumnKey,
  ValidatorKey,
  RelationKey,
  SoftDeleteKey,
} from "./decorators";
import {
  type DBConfig,
  type CacheConfig,
  type LoggerConfig,
  DBType,
  StabilizeError,
  type PoolMetrics,
  type QueryHint,
  RelationType,
  type CacheStats,
  LogLevel,
} from "./types";

export class Stabilize {
  private client: DBClient;
  private cache: Cache | null;
  private logger: Logger;

  constructor(
    config: DBConfig,
    cacheConfig: CacheConfig = { enabled: false, ttl: 60 },
    loggerConfig: LoggerConfig = {},
  ) {
    this.logger = new ConsoleLogger(loggerConfig);
    this.client = new DBClient(config, this.logger);
    this.cache = cacheConfig.enabled
      ? new Cache(cacheConfig, this.logger)
      : null;
  }

  getRepository<T>(model: new (...args: any[]) => T): Repository<T> {
    if (this.cache) {
      const cacheInstance = this.cache as any;
      const repoCacheConfig: CacheConfig = {
        enabled: true,
        ttl: 60,
        redisUrl: cacheInstance.redisUrl,
        cachePrefix: cacheInstance.prefix,
        strategy: this.cache.getStrategy(),
      };
      return new Repository(this.client, model, repoCacheConfig, this.logger);
    }

    return new Repository(
      this.client,
      model,
      { enabled: false, ttl: 60 },
      this.logger,
    );
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    return await this.client.transaction(callback);
  }

  async savepoint<T>(name: string, callback: () => Promise<T>): Promise<T> {
    return await this.client.savepoint(name, callback);
  }

  async switchConnection(config: DBConfig) {
    await this.client.switchConnection(config);
  }

  async getCacheStats(): Promise<CacheStats> {
    return this.cache
      ? await this.cache.getStats()
      : { hits: 0, misses: 0, keys: 0 };
  }

  getPoolMetrics(): PoolMetrics {
    return this.client.getPoolMetrics();
  }

  async close() {
    await this.client.close();
    if (this.cache) await this.cache.disconnect();
  }
}

export {
  // Types
  DBType,
  LogLevel,
  RelationType,
  StabilizeError,
  // Decorators
  Model,
  Column,
  Required,
  Unique,
  SoftDelete,
  OneToOne,
  ManyToOne,
  OneToMany,
  ManyToMany,
  ModelKey,
  ColumnKey,
  ValidatorKey,
  RelationKey,
  SoftDeleteKey,
  // Classes
  Cache,
  DBClient,
  QueryBuilder,
  Repository,
  ConsoleLogger,
  // Migrations
  runMigrations,
  generateMigration,
};

export type { Migration };
export type {
  DBConfig,
  CacheConfig,
  LoggerConfig,
  QueryHint,
  PoolMetrics,
  CacheStats,
  Logger,
};
