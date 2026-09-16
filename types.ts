/**
 * @file types.ts
 * @description Contains all shared type definitions and enums for the Stabilize ORM.
 * @author ElectronSz
 */

export enum DBType {
  Postgres = "postgres",
  MySQL = "mysql",
  SQLite = "sqlite",
  MSSQL = "mssql",
  MongoDB = "mongodb",
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
  /**
   * The MongoDB database to operate on.
   *
   * Only meaningful for `DBType.MongoDB`. Every other backend takes its
   * database from the connection string, but a mongo URI may legitimately omit
   * one (and often does in development), so it is accepted separately as well.
   * When both are present the URI's own path wins and this is ignored.
   */
  database?: string;
  /**
   * Extra options handed verbatim to the MongoDB driver's `MongoClient`.
   *
   * For `DBType.MongoDB` only. This is the escape hatch for driver settings the
   * ORM has no opinion about — `tls`, `authSource`, `maxPoolSize`, `retryWrites`
   * and the rest — without the ORM having to model, and stay current with, the
   * driver's full option surface.
   */
  mongoOptions?: Record<string, unknown>;
}

export interface CacheConfig {
  /** Whether to cache at all. A `true` here always builds a working cache. */
  enabled: boolean;
  /** Default time-to-live, in seconds. */
  ttl: number;
  /**
   * The Redis server to cache in.
   *
   * Optional, and genuinely so: without it the cache runs in process, backed by
   * {@link StabilizeKV}. That store is private to one process — not shared between
   * instances, not replicated, gone when the process exits — so pass a URL
   * whenever two application servers have to see the same cache. With one
   * server, a test suite or local development, leaving it out is fine and saves
   * running Redis.
   */
  redisUrl?: string;
  /** Prepended to every key, so one Redis can serve several applications. */
  cachePrefix?: string;
  /**
   * How many entries the in-process store holds before it evicts the least
   * recently used. Ignored when `redisUrl` is set — Redis does its own
   * eviction, and this would be a second, invisible one. Defaults to 1000.
   */
  maxEntries?: number;
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
  /**
   * Which store answered.
   *
   * Present so a cache that is not doing anything is distinguishable from one
   * that is merely cold: `"disabled"` means `enabled` was false, `"memory"`
   * means no `redisUrl` was configured and the cache is confined to this
   * process, and `"redis"` means a client was built — which reports the
   * configuration, not the connection, since `ioredis` connects lazily and may
   * fail to later.
   */
  backend: "redis" | "memory" | "disabled";
}

/**
 * The predicate shape a `QueryBuilder` records for MongoDB.
 *
 * Declared in `mongo-query`, where it is translated into a filter, and
 * re-exported here because this module is the package's public type surface:
 * `./types` is a published entry point and `./mongo-query` is not, so a consumer
 * that wants to name the shape — in a helper that builds conditions, or to
 * annotate a custom scope — would otherwise have no way to reach it.
 *
 * The re-export is type-only and therefore erased, so it adds no runtime edge
 * back into `mongo-query` (which imports `StabilizeError` from here).
 */
export type { Predicate } from "./mongo-query";

/**
 * One schema change against MongoDB, as data rather than as a closure.
 *
 * A discriminated union so a generated migration is serializable and assertable
 * without a server — the same reason `buildLimitClause` and
 * `buildMSSQLUpsertSQL` are pure. It lives here rather than beside the schema
 * derivation because `Migration` needs it, and `mongo-schema` already imports
 * from this module; declaring it there would make the two files import each
 * other.
 */
export type MongoStep =
  | { kind: "createCollection"; collection: string; validator?: any }
  | {
      kind: "createIndex";
      collection: string;
      spec: Record<string, 1 | -1>;
      options?: Record<string, any>;
    }
  | { kind: "dropIndex"; collection: string; name: string }
  | { kind: "collMod"; collection: string; validator: any }
  | { kind: "dropCollection"; collection: string }
  | { kind: "createCounter"; collection: string };

export interface Migration {
  name: string;
  up: string[];
  down: string[];
  /**
   * The MongoDB steps this migration applies.
   *
   * A sidecar rather than a replacement for `up`/`down`, because those are SQL
   * and `tests/migrations.test.ts` asserts their exact strings. A migration
   * generated for a SQL target leaves both of these undefined, and
   * `runMigrations` never reads them.
   */
  mongoUp?: MongoStep[];
  /** The MongoDB inverse of {@link mongoUp}. */
  mongoDown?: MongoStep[];
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
