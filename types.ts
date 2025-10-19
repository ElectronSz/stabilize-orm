/**
 * @file types.ts
 * @description Contains all shared type definitions and enums for the Stabilize ORM.
 * @author ElectronSz
 */

export enum DBType {
  Postgres = "postgres",
  MySQL = "mysql",
  SQLite = "sqlite",
}

export enum LogLevel {
  Debug,
  Info,
  Warn,
  Error,
}

export enum RelationType {
  OneToOne,
  OneToMany,
  ManyToOne,
  ManyToMany,
}

/**
 * An enumeration of abstract data types that are mapped to database-specific types.
 * This allows models to be defined in a database-agnostic way.
 */
export enum DataTypes {
  STRING,    // Maps to VARCHAR or TEXT
  TEXT,      // Maps to TEXT
  INTEGER,   // Maps to INTEGER or INT
  BIGINT,    // Maps to BIGINT
  FLOAT,     // Maps to REAL or FLOAT
  DOUBLE,    // Maps to DOUBLE PRECISION
  DECIMAL,   // Maps to DECIMAL or NUMERIC
  BOOLEAN,   // Maps to BOOLEAN or TINYINT/INTEGER
  DATE,      // Maps to DATE or TEXT
  DATETIME,  // Maps to TIMESTAMP, DATETIME, or TEXT
  JSON,      // Maps to JSON, JSONB, or TEXT
  UUID,      // Maps to UUID or VARCHAR(36)
  BLOB,      // Maps to BYTEA or BLOB
  
}

export interface DBConfig {
  type: DBType;
  connectionString: string;
  retryAttempts?: number;
  retryDelay?: number;
  maxJitter?: number;
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number;
  redisUrl?: string;
  cachePrefix?: string;
  strategy?: "cache-aside" | "write-through";
}

/**
 * Configuration for the logger.
 */
export interface LoggerConfig {
  level?: LogLevel;
  filePath?: string;
  maxFileSize?: number;
  maxFiles?: number;
}

export interface PoolMetrics {
  activeConnections: number;
  idleConnections: number;
  totalConnections: number;
}

export interface QueryHint {
  type: string;
  value: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  keys: number;
}

export interface Migration {
  name: string;
  up: string[];
  down: string[];
}

export class StabilizeError extends Error {
  constructor(
    message: string,
    public code: string,
    public originalError?: Error,
  ) {
    super(message);
    this.name = "StabilizeError";
  }
}