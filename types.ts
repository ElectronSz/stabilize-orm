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
  STRING, // Maps to VARCHAR or TEXT
  TEXT, // Maps to TEXT
  INTEGER, // Maps to INTEGER or INT
  BIGINT, // Maps to BIGINT
  FLOAT, // Maps to REAL or FLOAT
  DOUBLE, // Maps to DOUBLE PRECISION
  DECIMAL, // Maps to DECIMAL or NUMERIC
  BOOLEAN, // Maps to BOOLEAN or TINYINT/INTEGER
  DATE, // Maps to DATE or TEXT
  DATETIME, // Maps to TIMESTAMP, DATETIME, or TEXT
  JSON, // Maps to JSON, JSONB, or TEXT
  UUID, // Maps to UUID or VARCHAR(36)
  BLOB, // Maps to BYTEA or BLOB
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

export interface DefaultExpression {
  sql: string;
}

export function sqlDefault(sql: string): DefaultExpression {
  return { sql };
}

export type TransactionIsolationLevel =
  | "READ UNCOMMITTED"
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";

export interface QueryLogEntry {
  query: string;
  params: any[];
  durationMs: number;
  timestamp: Date;
  source: string;
}

export type StabilizeEvent =
  | "query"
  | "error"
  | "migration:start"
  | "migration:complete"
  | "transaction:start"
  | "transaction:complete"
  | "transaction:error"
  | "connection:open"
  | "connection:close";

export type StabilizeEventHandler = (...args: any[]) => void;

export class StabilizeEmitter {
  private listeners: Map<StabilizeEvent, StabilizeEventHandler[]> = new Map();

  on(event: StabilizeEvent, handler: StabilizeEventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  off(event: StabilizeEvent, handler: StabilizeEventHandler): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  emit(event: StabilizeEvent, ...args: any[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch {}
      }
    }
  }
}

export function generateUUID(): string {
  return crypto.randomUUID();
}
