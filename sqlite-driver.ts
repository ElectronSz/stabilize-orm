/**
 * @file sqlite-driver.ts
 * @description Resolves a SQLite driver at runtime so that one build runs on
 *   Bun and on Node.
 * @author ElectronSz
 *
 * Bun ships `bun:sqlite` and Node ships `node:sqlite`, and neither runtime has
 * the other's module. A static import of either therefore makes the whole
 * package unloadable on the runtime that lacks it — which is what a plain
 * `import ... from "bun:sqlite"` used to do to every Node consumer, including
 * ones that only ever used PostgreSQL or MongoDB.
 *
 * The two modules also differ in surface: Node's `DatabaseSync` has no `run()`.
 * This module hides both facts behind one small synchronous interface, so the
 * client keeps dispatching on a single class and nothing above it has to know
 * which runtime it woke up on.
 *
 * Resolution is synchronous on purpose: `DBClient.initializeClient` runs from
 * the constructor, and making it async to await a driver that is already
 * available in-process would ripple through every caller.
 */

import { createRequire } from "node:module";
import type { Database, Statement } from "bun:sqlite";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { StabilizeError } from "./types";

/**
 * A prepared statement, as the client uses one.
 *
 * Deliberately structural rather than a re-export of either driver's type: a
 * driver type in a public signature would reach the emitted `client.d.ts` and
 * make every consumer of the published package resolve a driver it may not even
 * run on. Same reasoning as `MSSQLHandle` and `MongoHandle` in `client.ts`.
 */
export interface SQLiteStatement {
  /** Runs the statement and returns every row. */
  all(...params: any[]): any[];
  /** Runs the statement and reports what it changed. */
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
}

/** Which runtime's driver a connection came from. */
export type SQLiteDriverKind = "bun" | "node";

/** Either driver's connection object. */
type AnyDatabase = Database | DatabaseSync;
/** Either driver's prepared statement. */
type AnyStatement = Statement | StatementSync;

type ResolvedDriver =
  | { kind: "bun"; module: typeof import("bun:sqlite") }
  | { kind: "node"; module: typeof import("node:sqlite") };

let cached: ResolvedDriver | null = null;
let failure: Error | null = null;

/**
 * Builds a `require` anchored at this module.
 *
 * `import.meta.url` is the correct anchor and is present in the ESM output the
 * build produces. The fallback exists only so a CommonJS consumer would get a
 * working driver lookup rather than a crash at import time.
 */
function driverRequire(): NodeRequire {
  let base: string;
  try {
    base = import.meta.url;
  } catch {
    base = `file://${process.cwd()}/`;
  }
  return createRequire(base);
}

/**
 * Finds a SQLite driver, preferring the runtime's own.
 *
 * Bun is tried first because `bun:sqlite` is the native module there and
 * `node:sqlite` is not implemented on Bun at all. On Node the first attempt
 * fails and the second succeeds. Both failures are ordinary catchable errors,
 * which is what keeps this synchronous.
 *
 * @returns The driver kind and its module.
 * @throws {StabilizeError} If neither driver is available.
 */
function resolveDriver(): ResolvedDriver {
  if (cached) return cached;
  if (failure) throw failure;

  const req = driverRequire();

  try {
    const module = req("bun:sqlite") as typeof import("bun:sqlite");
    if (typeof module?.Database === "function") {
      cached = { kind: "bun", module };
      return cached;
    }
  } catch {
    // Not Bun, or a Bun without `bun:sqlite`. Fall through to Node's driver.
  }

  try {
    const module = req("node:sqlite") as typeof import("node:sqlite");
    if (typeof module?.DatabaseSync === "function") {
      cached = { kind: "node", module };
      return cached;
    }
  } catch {
    // Not a Node with `node:sqlite`. Reported below.
  }

  failure = new StabilizeError(
    "No SQLite driver is available in this runtime. Bun provides `bun:sqlite` " +
      "and Node provides `node:sqlite` (Node 22.5 and later, no flag needed " +
      "from Node 24). Neither could be loaded here.",
    "SQLITE_DRIVER_MISSING",
  );
  throw failure;
}

/**
 * True for the error Node raises when an INTEGER holds more than
 * `Number.MAX_SAFE_INTEGER` and the statement is not reading bigints.
 */
function isOutOfRange(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return (error as { code?: string } | null)?.code === "ERR_OUT_OF_RANGE";
}

/** Passthrough over `bun:sqlite`, whose statement already matches the shape. */
class BunStatementAdapter implements SQLiteStatement {
  constructor(private readonly statement: Statement) {}

  all(...params: any[]): any[] {
    return this.statement.all(...params);
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.statement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

/**
 * Adapter over `node:sqlite`'s `StatementSync`.
 *
 * Node returns a plain `number` and **throws** `RangeError` when a column holds
 * more than `Number.MAX_SAFE_INTEGER`, where Bun silently returns a lossy
 * number. `setReadBigInts` is per-statement and all-or-nothing, so enabling it
 * up front would turn every `id` column into a bigint on Node while Bun kept
 * returning numbers — a difference on every row, to cover a rare case. Instead
 * the error is caught and that one read retried with bigints: values in range
 * stay numbers, exactly as on Bun, and a value out of range comes back exact
 * instead of corrupted.
 *
 * The trade-off worth knowing: once a statement has been flipped, every integer
 * column in its rows is a bigint, including ones that would have fitted.
 */
class NodeStatementAdapter implements SQLiteStatement {
  private readsBigInts = false;

  constructor(private readonly statement: StatementSync) {}

  /**
   * Switches the statement to bigint reads.
   *
   * @returns False if this Node predates `setReadBigInts`, so the caller can
   *   rethrow the original error rather than turning it into a `TypeError`.
   */
  private useBigInts(): boolean {
    if (this.readsBigInts) return true;
    if (typeof this.statement.setReadBigInts !== "function") return false;
    this.statement.setReadBigInts(true);
    this.readsBigInts = true;
    return true;
  }

  all(...params: any[]): any[] {
    try {
      return this.statement.all(...params);
    } catch (error) {
      if (!isOutOfRange(error) || !this.useBigInts()) throw error;
      return this.statement.all(...params);
    }
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    let result: ReturnType<StatementSync["run"]>;
    try {
      result = this.statement.run(...params);
    } catch (error) {
      if (!isOutOfRange(error) || !this.useBigInts()) throw error;
      result = this.statement.run(...params);
    }
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

/**
 * A SQLite connection, backed by whichever driver this runtime provides.
 *
 * A class rather than a factory function because the client identifies its
 * SQLite branch with `instanceof` in five places, and that check has to name
 * something that exists on both runtimes.
 */
export class SQLiteConnection {
  private readonly db: AnyDatabase;
  private readonly kind: SQLiteDriverKind;
  private readonly adapt: (statement: AnyStatement) => SQLiteStatement;

  /**
   * Opens a connection.
   * @param filename The database file, or `:memory:`.
   * @param options Bun-only. `bun:sqlite` needs `{ create: true }` to create a
   *   missing file; `node:sqlite` creates one on open and has no such option,
   *   so it is not passed there.
   */
  constructor(filename: string, options?: { create?: boolean }) {
    const { kind, module } = resolveDriver();
    this.kind = kind;
    if (kind === "node") {
      // `node:sqlite` creates a missing database file on open and has no
      // `create` option, so the client's `{ create: true }` is Bun-only.
      this.db = new module.DatabaseSync(filename);
      this.adapt = (statement) =>
        new NodeStatementAdapter(statement as StatementSync);
    } else {
      this.db = new module.Database(filename, options ?? {});
      this.adapt = (statement) =>
        new BunStatementAdapter(statement as Statement);
    }
  }

  /** The runtime whose driver this connection is using. */
  get driver(): SQLiteDriverKind {
    return this.kind;
  }

  /**
   * Prepares a statement.
   *
   * Node's `DatabaseSync` has no `run()`, so `SQLiteConnection.run` is built on
   * this rather than on a driver method of its own.
   */
  prepare(sql: string): SQLiteStatement {
    return this.adapt(this.db.prepare(sql) as AnyStatement);
  }

  /** Runs a statement in one call, for callers with no statement to cache. */
  run(
    sql: string,
    ...params: any[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    return this.prepare(sql).run(...params);
  }

  /** Closes the connection. */
  close(): void {
    this.db.close();
  }
}
