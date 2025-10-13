import Redis from 'ioredis';
import { type CacheConfig, type CacheStats } from './types';
import { ConsoleLogger, type Logger } from './logger';

export class Cache {
  private redis: Redis | null = null;
  private ttl: number;
  private prefix: string;
  private strategy: 'cache-aside' | 'write-through';
  private logger: Logger;
  private hits: number = 0;
  private misses: number = 0;

  constructor(config: CacheConfig, logger: Logger = new ConsoleLogger()) {
    this.ttl = config.ttl;
    this.prefix = config.cachePrefix || 'cache:';
    this.strategy = config.strategy || 'cache-aside';
    this.logger = logger;

    if (config.enabled && config.redisUrl) {
      this.redis = new Redis(config.redisUrl, { lazyConnect: true });
      this.redis.on('error', (error) => this.logger.logError(error));
    }
  }

  getStrategy() {
    return this.strategy;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;

    try {
      const data = await this.redis.get(this.prefix + key);
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

  async set<T>(key: string, value: T, ttl: number = this.ttl): Promise<void> {
    if (!this.redis) return;

    try {
      await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', ttl);
      this.logger.logDebug(`Cache set for key: ${key}`);
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  async invalidate(keys: string[]): Promise<void> {
    if (!this.redis) return;

    try {
      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.del(this.prefix + key);
        this.logger.logDebug(`Cache invalidated for key: ${key}`);
      }
      await pipeline.exec();
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    if (!this.redis) return;

    try {
      const keys = await this.redis.keys(this.prefix + pattern);
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.del(key);
          this.logger.logDebug(`Cache invalidated for pattern: ${pattern}`);
        }
        await pipeline.exec();
      }
    } catch (error) {
      this.logger.logError(error as Error);
    }
  }

  async getStats(): Promise<CacheStats> {
    if (!this.redis) return { hits: 0, misses: 0, keys: 0 };
    try {
      const keys = await this.redis.keys(this.prefix + '*');
      return { hits: this.hits, misses: this.misses, keys: keys.length };
    } catch (error) {
      this.logger.logError(error as Error);
      return { hits: this.hits, misses: this.misses, keys: 0 };
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.logger.logInfo('Redis connection closed');
    }
  }
}