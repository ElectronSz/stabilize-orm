// src/types.ts
export enum DBType {
  SQLite = 'sqlite',
  MySQL = 'mysql',
  Postgres = 'postgres',
}

export interface DBConfig {
  type: DBType;
  connectionString: string;
  poolSize?: number;
  retryAttempts?: number;
  retryDelay?: number;
  maxJitter?: number;
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number;
  redisUrl?: string;
  cachePrefix?: string;
  strategy?: 'cache-aside' | 'write-through';
}

export interface LoggerConfig {
  level?: LogLevel;
  filePath?: string;
  maxFileSize?: number;
  maxFiles?: number;
}

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

export interface CacheStats {
  hits: number;
  misses: number;
  keys: number;
}

export enum RelationType {
  OneToOne = 'one-to-one',
  OneToMany = 'one-to-many',
  ManyToOne = 'many-to-one',
  ManyToMany = 'many-to-many',
}

export interface QueryHint {
  type: 'INDEX' | 'FORCE_INDEX' | 'USE_INDEX';
  value: string;
}

export interface PoolMetrics {
  activeConnections: number;
  idleConnections: number;
  totalConnections: number;
}

export interface Migration {
  up: string[];
  down: string[];
}

export class StabilizeError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'StabilizeError';
  }
}