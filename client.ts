/**
 * @file client.ts
 * @description Provides a unified database client for interacting with PostgreSQL, MySQL, and SQLite.
 * @author ElectronSz
 */

import { Database, Statement } from "bun:sqlite";
import { Pool, type PoolClient } from "pg";
import mysql from "mysql2/promise";
import sql from "mssql";
import { type DBConfig, StabilizeError, DBType } from "./types";
import { type Logger, StabilizeLogger } from "./logger";

/**
 * Checks if the DB configuration is for SQLite.
 * @param config The database configuration object.
 * @returns True if the configuration is for SQLite, false otherwise.
 */
function isSQLiteConfig(config: DBConfig): boolean {
  return config.type === DBType.SQLite;
}

/**
 * Checks if the DB configuration is for MySQL.
 * @param config The database configuration object.
 * @returns True if the configuration is for MySQL, false otherwise.
 */
function isMySQLConfig(config: DBConfig): boolean {
  return config.type === DBType.MySQL;
}

/**
 * Checks if the DB configuration is for SQL Server.
 * @param config The database configuration object.
 * @returns True if the configuration is for SQL Server, false otherwise.
 */
function isMSSQLConfig(config: DBConfig): boolean {
  return config.type === DBType.MSSQL;
}

/**
 * Rewrites the library's `?` placeholders into a dialect's own parameter
 * syntax.
 *
 * Every statement the ORM generates is written with `?`, and each driver
 * numbers its parameters differently: PostgreSQL uses `$1`, SQL Server uses
 * `@param0`. MySQL and SQLite take `?` as written, so their input is returned
 * untouched.
 *
 * Exported, and kept free of any client state, so the rewrite can be asserted
 * directly rather than through a live connection.
 *
 * @param query The SQL statement using `?` placeholders.
 * @param dbType The target database dialect.
 * @returns The statement with placeholders in the dialect's syntax.
 */
export function rewritePlaceholders(query: string, dbType: DBType): string {
  if (dbType === DBType.Postgres) {
    let paramIndex = 0;
    return query.replace(/\?/g, () => `$${++paramIndex}`);
  }
  if (dbType === DBType.MSSQL) {
    let paramIndex = 0;
    return query.replace(/\?/g, () => `@param${paramIndex++}`);
  }
  return query;
}

/**
 * Binds one positional parameter to an mssql request.
 *
 * mssql infers a parameter's type from the value it is handed, and has nothing
 * to infer from for `null` or `undefined` — the request would be sent with a
 * type the server rejects. Those are therefore bound explicitly as a nullable
 * `NVARCHAR`, which every column type accepts as a NULL.
 *
 * A plain object or array needs the same treatment for a different reason.
 * Only `pg` serialises an object parameter to JSON on the way out; mssql has no
 * such fallback and fails the whole statement with "Validation failed for
 * parameter 'paramN'. Invalid string.", and `mysql2` does something worse still
 * (@see bindMySQLParams). Encoding it here gives SQL Server the behaviour
 * Postgres has.
 *
 * `Date` and `Buffer` are left to mssql, which infers a correct type for both.
 *
 * Exported so the binding rules can be asserted against a stub rather than a
 * server.
 *
 * @param request The mssql request to bind onto.
 * @param index The parameter's position, zero-based.
 * @param value The value to bind.
 */
export function bindMSSQLParam(
  request: { input: (name: string, typeOrValue: any, value?: any) => any },
  index: number,
  value: any,
): void {
  const name = `param${index}`;
  if (value === null || value === undefined) {
    request.input(name, sql.NVarChar, null);
  } else if (isPlainJsonValue(value)) {
    request.input(name, sql.NVarChar, JSON.stringify(value));
  } else {
    request.input(name, value);
  }
}

/**
 * Reports whether a value should be sent to a JSON column as JSON text.
 *
 * Only plain objects and arrays qualify. Anything with its own prototype —
 * `Date`, `Buffer`, a class instance — carries meaning the drivers already know
 * how to encode, and stringifying it would silently corrupt the column.
 *
 * @param value The parameter value.
 * @returns True when the value should be JSON-encoded.
 */
export function isPlainJsonValue(value: any): boolean {
  if (Array.isArray(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Encodes the parameters of a MySQL-family statement for the driver.
 *
 * `mysql2` does not serialise an object to JSON the way `pg` does. It treats a
 * plain object as a set of assignments — `{ nested: 1 }` binds as
 * `` `nested` = 1 `` — which is meaningful only in an `UPDATE … SET` list and
 * is a syntax error anywhere else. Bound inside a `VALUES` clause it rewrites
 * the statement into one the server cannot parse: a single object parameter
 * becomes several, and either the column count no longer matches ("Column
 * count doesn't match value count at row 1", ER_WRONG_VALUE_COUNT_ON_ROW 1136)
 * or the object's own keys are read as column names ("Unknown column 'nested'
 * in 'field list'", ER_BAD_FIELD_ERROR 1054). A JSON column is therefore
 * unwritable unless the value reaches the driver as text, which is what this
 * does — the same answer `bindMSSQLParam` gives PostgreSQL's behaviour to SQL
 * Server.
 *
 * The array is returned as a new list rather than mutated: callers reuse the
 * parameter array they built, and on MySQL-less paths it must stay untouched.
 *
 * @param params The statement's positional parameters.
 * @returns The parameters as the driver should receive them.
 */
export function bindMySQLParams(params: any[]): any[] {
  return params.map((value) =>
    isPlainJsonValue(value) ? JSON.stringify(value) : value,
  );
}

/** Statement prefixes that cannot change any data, and so can be replayed. */
const READ_ONLY_PREFIXES = ["SELECT", "PRAGMA", "SHOW", "EXPLAIN", "VALUES"];

/**
 * Checks whether a statement is safe to run more than once.
 *
 * Used to decide whether a failed statement may be retried. Anything not
 * recognised as a read is treated as a write, so an unfamiliar statement is
 * run once rather than risk being applied twice.
 *
 * @param query The SQL statement.
 * @returns True when the statement only reads.
 */
function isReadOnlyStatement(query: string): boolean {
  // Leading comments and whitespace are stripped so `/* hint */ SELECT …`
  // is still recognised.
  const stripped = query
    .replace(/^\s*(?:\/\*[\s\S]*?\*\/|--[^\n]*\n|\s)+/, "")
    .toUpperCase();
  return READ_ONLY_PREFIXES.some(
    (prefix) =>
      stripped.startsWith(prefix) &&
      // Guard against a prefix matching a longer word, e.g. `SELECTED`.
      !/^[A-Z_]/.test(stripped.slice(prefix.length)),
  );
}

/**
 * Checks if the given client is a MySQL pool.
 * @param client The database client.
 * @returns True if the client is a MySQL pool, false otherwise.
 */
function isMySQLPool(client: any): client is mysql.Pool {
  return typeof client.getConnection === "function";
}

/**
 * The shape of the mssql handles this client stores.
 *
 * Deliberately structural rather than `sql.ConnectionPool | sql.Transaction`.
 * Naming those types would make the emitted `client.d.ts` import `mssql`, and
 * every consumer of the published package — including one that only ever talks
 * to SQLite — would then need declarations for a driver it does not use. A pool
 * exposes `connect`, `close` and `request`; an open transaction exposes
 * `begin`, `commit` and `rollback`, and is recognised by `begin`.
 */
interface MSSQLHandle {
  connect?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
  request?: () => unknown;
  begin?: (...args: any[]) => any;
  commit?: (...args: any[]) => any;
  rollback?: (...args: any[]) => any;
}

/**
 * The shape of the MongoDB handles this client stores.
 *
 * Structural for the same reason `MSSQLHandle` is — naming the driver's own
 * types would emit an import of the `mongodb` package into `client.d.ts`, and
 * every consumer of the published package would then need declarations for a
 * driver most of them never install.
 *
 * Unlike mssql, though, the driver *does* ship its own declarations, so there
 * is deliberately no ambient shim module here: one would shadow the real types
 * for the ORM build and for any consumer that does use the driver.
 *
 * A `MongoClient` is recognised by `db`, a `ClientSession` by `withTransaction`.
 */
interface MongoHandle {
  connect?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
  db?: (name?: string) => MongoDbHandle;
  startSession?: () => MongoSessionHandle;
}

/** A `ClientSession`, which is what an open transaction actually is. */
interface MongoSessionHandle {
  withTransaction?: (...args: any[]) => any;
  endSession?: () => Promise<unknown>;
}

/** A `Db` — the handle collections are read from. */
interface MongoDbHandle {
  collection?: (name: string) => MongoCollectionHandle;
  command?: (
    command: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<any>;
  listCollections?: (...args: any[]) => MongoCursorHandle;
  createCollection?: (...args: any[]) => Promise<unknown>;
  admin?: () => { command: (command: Record<string, unknown>) => Promise<any> };
}

/** A `Collection`. Only the members the ORM actually reaches for. */
interface MongoCollectionHandle {
  find: (...args: any[]) => MongoCursorHandle;
  findOne: (...args: any[]) => Promise<any>;
  insertOne: (...args: any[]) => Promise<MongoUpdateResult>;
  insertMany: (...args: any[]) => Promise<MongoUpdateResult>;
  updateOne: (...args: any[]) => Promise<MongoUpdateResult>;
  updateMany: (...args: any[]) => Promise<MongoUpdateResult>;
  deleteOne: (...args: any[]) => Promise<MongoUpdateResult>;
  deleteMany: (...args: any[]) => Promise<MongoUpdateResult>;
  countDocuments: (...args: any[]) => Promise<number>;
  distinct: (...args: any[]) => Promise<any[]>;
  aggregate: (...args: any[]) => MongoCursorHandle;
  findOneAndUpdate: (...args: any[]) => Promise<any>;
  bulkWrite: (...args: any[]) => Promise<MongoUpdateResult>;
  createIndex: (...args: any[]) => Promise<unknown>;
  listIndexes: (...args: any[]) => MongoCursorHandle;
  drop?: (...args: any[]) => Promise<unknown>;
  indexes?: (...args: any[]) => Promise<any[]>;
}

/** A `FindCursor` or `AggregationCursor`. */
interface MongoCursorHandle {
  toArray: () => Promise<any[]>;
  sort?: (...args: any[]) => MongoCursorHandle;
  skip?: (...args: any[]) => MongoCursorHandle;
  limit?: (...args: any[]) => MongoCursorHandle;
  project?: (...args: any[]) => MongoCursorHandle;
  hasNext?: () => Promise<boolean>;
  next?: () => Promise<any>;
  close?: () => Promise<unknown>;
}

/** What a mongo write reports back. Field-for-field the driver's own result. */
interface MongoUpdateResult {
  acknowledged?: boolean;
  matchedCount?: number;
  modifiedCount?: number;
  upsertedCount?: number;
  upsertedId?: any;
  insertedCount?: number;
  deletedCount?: number;
}

/**
 * Handles whose replica-set support has already been probed.
 *
 * A transaction-bound client shares its parent's `MongoClient` object, so
 * without this the probe would run again on every transaction — and the probe
 * is a round trip on the hottest path in the library.
 */
const replicaSetProbed = new WeakSet<object>();

/**
 * Loads the MongoDB driver, which is an optional dependency.
 *
 * The specifier is held in a variable on purpose. A literal dynamic import is
 * resolved statically by the bundler and by `tsc`, neither of which should
 * require the driver to be present for a build or typecheck of the SQL
 * backends.
 *
 * @returns The driver module.
 * @throws StabilizeError when the driver is not installed.
 */
async function loadMongoDriver(): Promise<any> {
  const specifier = "mongodb";
  try {
    return await import(specifier);
  } catch {
    throw new StabilizeError(
      "The MongoDB driver is not installed. DBType.MongoDB requires it as an " +
        "optional peer: install it with `bun add mongodb` or `npm install mongodb`.",
      "MONGO_DRIVER_MISSING",
    );
  }
}

/**
 * Provides a unified database client for interacting with PostgreSQL, MySQL, and SQLite.
 */
export class DBClient {
  private client!:
    | Database
    | Pool
    | mysql.Pool
    | PoolClient
    | mysql.PoolConnection
    | MSSQLHandle
    | MongoHandle;
  private logger: Logger;
  public readonly config: DBConfig;
  private retryAttempts: number;
  private retryDelay: number;
  private maxJitter: number;

  /**
   * The in-flight `connect()` on the mssql pool, if one has been started.
   * Held so that concurrent callers share a single connection attempt rather
   * than each opening one.
   */
  private mssqlConnectPromise: Promise<void> | null = null;

  /**
   * The in-flight connect on the mongo client, held for the same reason as
   * `mssqlConnectPromise`. It resolves to the connected handle so that callers
   * that need to reach a collection do not have to re-derive it.
   */
  private mongoConnectPromise: Promise<MongoHandle> | null = null;

  /**
   * The mongo session every statement on this client should run inside.
   *
   * Kept beside `client` rather than *as* `client`, unlike mssql. A mongo
   * transaction is not a different connection the way `sql.Transaction` is: the
   * commands still go to the same `MongoClient`, and the session is passed
   * alongside them as an option. Storing it separately is what lets a
   * transaction-bound client still resolve its parent's collections.
   */
  private mongoSession: MongoSessionHandle | null = null;

  private preparedStatements: Map<string, Statement> = new Map();
  public isTransactionClient: boolean = false;

  /**
   * Constructs a new DBClient instance.
   * @param config The database configuration object.
   * @param logger Optional logger instance. Uses StabilizeLogger if not provided.
   * @param existingClient Optional existing transaction client. For SQL Server
   *   this is the `sql.Transaction` the statements should run inside; for
   *   MongoDB it is the parent `MongoClient`, shared with the session below.
   * @param mongoSession Optional session that scopes statements to a
   *   transaction. Only MongoDB uses it.
   */
  constructor(
    config: DBConfig,
    logger: Logger = new StabilizeLogger(),
    existingClient:
      | PoolClient
      | mysql.PoolConnection
      | MSSQLHandle
      | MongoHandle
      | null = null,
    mongoSession: MongoSessionHandle | null = null,
  ) {
    this.config = config;
    this.logger = logger;
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.maxJitter = config.maxJitter || 100;

    if (existingClient) {
      this.client = existingClient;
      this.isTransactionClient = true;
      this.mongoSession = mongoSession;
    } else {
      this.initializeClient(config);
    }
  }

  /**
   * Initializes the database client based on the configuration.
   * @param config The database configuration object.
   */
  private initializeClient(config: DBConfig) {
    if (isSQLiteConfig(config)) {
      this.client = new Database(config.connectionString, { create: true });
      this.logger.logDebug(`Initialized Bun SQLite client.`);
    } else if (isMySQLConfig(config)) {
      this.client = mysql.createPool(config.connectionString);
      this.logger.logDebug(`Initialized MySQL Pool client.`);
    } else if (config.type === DBType.Postgres) {
      this.client = new Pool({ connectionString: config.connectionString! });
      this.logger.logDebug(`Initialized Postgres Pool client.`);
    } else if (isMSSQLConfig(config)) {
      // The pool object is built here but deliberately left unconnected:
      // `ConnectionPool.connect()` is asynchronous and this method is called
      // from the constructor, so awaiting it would make construction async for
      // every driver. `ensureMSSQLConnected` opens it on first use instead.
      this.client = new sql.ConnectionPool(config.connectionString);
      this.logger.logDebug(`Initialized MSSQL Pool client.`);
    } else if (config.type === DBType.MongoDB) {
      // Same constraint as mssql, one step worse: the driver is an optional
      // dependency, so reaching it needs `await import()` — which cannot happen
      // from a constructor either. `ensureMongoConnected` does both the import
      // and the connect on first use and fills `client` in then. Nothing may
      // touch `this.client` for a mongo config before awaiting it.
      this.client = null as unknown as MongoHandle;
      this.logger.logDebug(`Deferred MongoDB client initialization.`);
    }
  }

  /**
   * Opens the mongo client, once, on first use.
   *
   * Performs the lazy `import()` of the optional driver and then `connect()`,
   * mirroring `ensureMSSQLConnected`. The promise is memoised so concurrent
   * first queries share one connection attempt.
   *
   * @returns The connected mongo handle.
   * @throws StabilizeError when the driver is absent or a handle is malformed.
   */
  private async ensureMongoConnected(): Promise<MongoHandle> {
    if (!this.mongoConnectPromise) {
      this.mongoConnectPromise = this.openMongoClient();
    }
    return this.mongoConnectPromise;
  }

  /** Builds and connects the mongo client. See `ensureMongoConnected`. */
  private async openMongoClient(): Promise<MongoHandle> {
    let handle = this.client as MongoHandle | null;

    if (!handle || typeof handle.db !== "function") {
      const driver = await loadMongoDriver();
      const options: Record<string, unknown> = {
        ...(this.config.mongoOptions ?? {}),
      };
      // The URI's own database wins when it has one; the driver only consults
      // `dbName` when the path is empty.
      if (this.config.database && !options.dbName) {
        options.dbName = this.config.database;
      }
      handle = new driver.MongoClient(
        this.config.connectionString,
        options,
      ) as MongoHandle;
      this.client = handle;
    }

    if (typeof handle.connect === "function") {
      await handle.connect();
    }
    this.logger.logDebug("MongoDB client connected.");
    await this.assertReplicaSetOrExplained(handle);
    return handle;
  }

  /**
   * Warns, once per client, when the server cannot serve transactions.
   *
   * Every write in the ORM is wrapped in a transaction, and MongoDB only
   * supports those on a replica set or sharded cluster. A standalone `mongod`
   * accepts the connection, answers every read, and then rejects the first
   * `startTransaction` with a bare `IllegalOperation` — so without this the
   * failure surfaces as "create() does not work" with nothing pointing at the
   * cause. A warning at connect time names it.
   *
   * Deliberately not fatal: reads work fine standalone, and refusing to connect
   * would break the read-only use someone may legitimately have.
   */
  private async assertReplicaSetOrExplained(handle: MongoHandle): Promise<void> {
    if (replicaSetProbed.has(handle)) return;
    replicaSetProbed.add(handle);

    const db = handle.db?.(this.config.database);
    const admin = db?.admin?.();
    if (!admin || typeof admin.command !== "function") return;

    try {
      const hello = await admin.command({ hello: 1 });
      if (hello && !hello.setName && !hello.msg) {
        this.logger.logWarn(
          "MongoDB is running as a standalone server. Transactions require a " +
            "replica set, so every write — including create(), which the ORM " +
            "always wraps in one — will fail with an IllegalOperation error. " +
            "Start the server with --replSet and run rs.initiate(), or connect " +
            "to an existing replica set.",
        );
      }
    } catch (error) {
      // A server that will not answer `hello` is not one this check can say
      // anything useful about; the real error will surface on first use.
      this.logger.logDebug(
        `Could not probe MongoDB replica-set support: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Turns the driver's bare "Transaction numbers are only allowed on a replica
   * set member or mongos" into an error that says what to do about it.
   *
   * Code 20 (`IllegalOperation`) is the one a standalone server returns from
   * `startTransaction`. It is worth naming precisely because the symptom is so
   * far from the cause: reads work, the connection is healthy, and only writes
   * fail — because the ORM wraps every write in a transaction.
   *
   * @param error Whatever the driver threw.
   * @returns A StabilizeError preserving the original as `cause`.
   */
  private explainMongoTransactionFailure(error: unknown): StabilizeError {
    const code = (error as { code?: number })?.code;
    const message = (error as Error)?.message ?? String(error);

    // The infrastructure signature is looked for *first*, and deliberately not
    // after the pass-through below. The executor family wraps every driver
    // failure in a `MONGO_ERROR` whose own `code` is a string, so by the time a
    // code-20 rejection gets here the number is gone and the driver's wording
    // survives only inside the wrapper's message. Checking `instanceof` first
    // would hand that wrapper straight back and report a standalone server as a
    // generic mongo error.
    if (code === 20 || /replica set|mongos/i.test(message)) {
      return new StabilizeError(
        "MongoDB transactions require a replica set or sharded cluster, and " +
          "this server is a standalone. Every write goes through a transaction, " +
          "so start the server with --replSet and run rs.initiate() (or point " +
          `the connection at an existing replica set). Driver said: ${message}`,
        "TX_ERROR",
        error as Error,
      );
    }

    // Anything the ORM has already classified — a validation failure, an
    // optimistic-lock conflict, a row that is not there, or a write the driver
    // refused — is the answer, and the four SQL branches all let theirs through
    // untouched. Rewriting it as a transaction failure gave the caller the
    // wrong code to branch on and the wrong thing to go and look at: a payload
    // that failed validation sent the reader to the server's replica-set
    // config.
    if (error instanceof StabilizeError) return error;

    return new StabilizeError(message, "TX_ERROR", error as Error);
  }

  /**
   * Resolves the database handle statements should be issued against.
   * @returns The connected `Db`.
   * @throws StabilizeError when the handle exposes no `db()`.
   */
  private async mongoDb(): Promise<MongoDbHandle> {
    const handle = await this.ensureMongoConnected();
    const db = handle.db?.(this.config.database);
    if (!db) {
      throw new StabilizeError(
        "MongoDB client did not provide a database handle.",
        "MONGO_ERROR",
      );
    }
    return db;
  }

  /**
   * The options every mongo command must carry.
   *
   * A transaction-bound client contributes its session here; a plain one
   * contributes nothing. Threading it through every executor is what makes a
   * repository write performed inside `transaction()` actually participate in
   * it, rather than silently committing on its own.
   */
  private mongoOptions(): Record<string, unknown> {
    return this.mongoSession ? { session: this.mongoSession } : {};
  }

  /**
   * Rejects a SQL statement sent to a MongoDB client.
   *
   * There is no fifth branch to add to `query`: a mongo command is a document,
   * not a string, so there is nothing for the SQL path to dispatch on. Failing
   * loudly here means a caller who reached for `rawQuery` against mongo gets a
   * sentence explaining why, rather than a driver-level parse error.
   *
   * @throws StabilizeError always, when this client is a mongo client.
   */
  private rejectSQLForMongo(): void {
    throw new StabilizeError(
      "Raw SQL is not available on MongoDB. The Mongo backend speaks commands " +
        "and documents rather than statements, so rawQuery/rawExec and the " +
        "query-builder's SQL-only clauses (join, union, whereRaw, orderByRaw, " +
        "selectRaw, groupByRaw, having, whereExists) have no equivalent. Use " +
        "the repository API or the query builder's structured methods instead.",
      "MONGO_UNSUPPORTED",
    );
  }

  /**
   * Opens the mssql pool, once, on first use.
   *
   * `initializeClient` cannot do this — see the note there — so every statement
   * awaits it before building its request. The promise is memoised so that
   * concurrent first queries share one connection attempt.
   *
   * A client holding an `sql.Transaction` has nothing to connect: the
   * transaction already owns a pooled connection, and `connect()` does not
   * exist on it.
   */
  private async ensureMSSQLConnected(): Promise<void> {
    const pool = this.client as MSSQLHandle;
    if (!pool || typeof pool.connect !== "function") return;
    if (!this.mssqlConnectPromise) {
      this.mssqlConnectPromise = pool.connect().then(() => {
        this.logger.logDebug("MSSQL pool connected.");
      });
    }
    await this.mssqlConnectPromise;
  }

  /**
   * Builds the mssql request a statement should run through.
   *
   * A transaction-bound client holds an `sql.Transaction`, and `begin()` is
   * what distinguishes it: a statement sent through a `Request` built from the
   * transaction stays inside it, whereas one built from the pool would run on
   * an unrelated connection and commit on its own.
   */
  private async mssqlRequest(): Promise<sql.Request> {
    const handle = this.client as MSSQLHandle;
    if (handle && typeof handle.begin === "function") {
      return new sql.Request(handle as any);
    }
    await this.ensureMSSQLConnected();
    return new sql.Request(handle as any);
  }

  /**
   * Sends one statement through a fresh mssql request and resolves its result.
   *
   * Parameter values are bound in order under the names the placeholder
   * rewrite produced, so the statement the server sees carries neither more
   * nor fewer parameters than were supplied.
   */
  private async runMSSQL(
    query: string,
    params: any[],
  ): Promise<{ recordset: any[]; rowsAffected: number[] }> {
    const request = await this.mssqlRequest();
    params.forEach((value, index) => bindMSSQLParam(request, index, value));
    return request.query(rewritePlaceholders(query, DBType.MSSQL));
  }

  /**
   * Returns a random jitter value for retry logic.
   * @returns A random number up to maxJitter.
   */
  private getJitter = () => Math.random() * this.maxJitter;

  /**
   * Executes a SQL query with retries and returns the resulting rows.
   * @param query The SQL query string.
   * @param params Query parameters.
   * @returns Array of resulting rows.
   * @throws StabilizeError if all retry attempts fail.
   */
  async query<T>(query: string, params: any[] = []): Promise<T[]> {
    if (this.config.type === DBType.MongoDB) this.rejectSQLForMongo();
    const start = Date.now();

    // Only reads are retried. Every write in the ORM — insert, update, delete,
    // upsert — goes through this method, and a failure that happened *after*
    // the database committed (a dropped connection on the way back, say) would
    // be retried and applied a second time. A read is safe to repeat.
    const attempts = isReadOnlyStatement(query) ? this.retryAttempts : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        let result: any;

        if (this.client instanceof Database) {
          let stmt = this.preparedStatements.get(query);
          if (!stmt) {
            stmt = this.client.prepare(query);
            this.preparedStatements.set(query, stmt);
          }
          result = stmt.all(...params);
        } else if (this.config.type === DBType.MySQL) {
          const [rows] = await (this.client as mysql.Pool).query(
            query,
            bindMySQLParams(params),
          );
          result = rows;
        } else if (this.config.type === DBType.Postgres) {
          const pgResult = await (this.client as Pool).query(
            rewritePlaceholders(query, DBType.Postgres),
            params,
          );
          result = Array.isArray(pgResult.rows) ? pgResult.rows : [];
        } else if (this.config.type === DBType.MSSQL) {
          const mssqlResult = await this.runMSSQL(query, params);
          result = Array.isArray(mssqlResult.recordset)
            ? mssqlResult.recordset
            : [];
        } else {
          throw new StabilizeError(
            "Unknown database client type",
            "QUERY_ERROR",
          );
        }

        const executionTime = Date.now() - start;
        this.logger.logQuery(query, params, executionTime);
        return Array.isArray(result) ? (result as T[]) : [];
      } catch (error) {
        this.logger.logError(error as Error);
        if (attempt === attempts) {
          throw new StabilizeError(
            `Query failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${(error as Error).message}`,
            "QUERY_ERROR",
          );
        }
        await new Promise((res) =>
          setTimeout(
            res,
            this.retryDelay * Math.pow(2, attempt - 1) + this.getJitter(),
          ),
        );
      }
    }
    throw new StabilizeError(
      "Query failed: maximum retries reached without success",
      "QUERY_ERROR",
    );
  }

  /**
   * Runs a callback within a database transaction.
   * Handles commit/rollback and connection release.
   * @param callback The callback to execute within the transaction context.
   * @returns The result of the callback.
   * @throws StabilizeError if transactions are not supported or rollback is triggered.
   */
  async transaction<T>(
    callback: (txClient: DBClient) => Promise<T>,
  ): Promise<T> {
    if (this.isTransactionClient) return callback(this);

    if (this.client instanceof Database) {
      // `bun:sqlite`'s own `db.transaction()` is synchronous: it issues
      // COMMIT as soon as the callback returns, and an async callback returns
      // a pending promise at its first `await`. The COMMIT would therefore
      // land before the work finished, so a later throw rolled nothing back
      // and every write in the library ran non-atomically. Drive the
      // transaction explicitly instead, which awaits properly.
      this.logger.logDebug("Starting SQLite transaction.");
      // SQLite runs on a single connection, so the callback receives this same
      // client rather than a new one. Mark it as being inside a transaction for
      // the duration: without that, a nested `transaction()` (a repository
      // write inside the caller's transaction) would issue a second BEGIN and
      // fail with "cannot start a transaction within a transaction".
      const wasTransactionClient = this.isTransactionClient;
      this.isTransactionClient = true;
      await this.migrationQuery("BEGIN");
      try {
        const result = await callback(this);
        await this.migrationQuery("COMMIT");
        return result;
      } catch (error) {
        try {
          await this.migrationQuery("ROLLBACK");
        } catch (rollbackError) {
          this.logger.logError(rollbackError as Error);
        }
        throw error;
      } finally {
        this.isTransactionClient = wasTransactionClient;
      }
    }

    if (this.config.type === DBType.MongoDB) {
      const handle = await this.ensureMongoConnected();
      if (typeof handle.startSession !== "function") {
        throw new StabilizeError(
          "MongoDB client cannot start a session, so transactions are unavailable.",
          "TX_ERROR",
        );
      }

      const session = handle.startSession();
      // The transaction-bound client keeps the parent's `MongoClient` and adds
      // the session, because mongo commands carry a session rather than being
      // sent through a different connection.
      const txClient = new DBClient(this.config, this.logger, handle, session);
      this.logger.logDebug("Starting MongoDB transaction.");

      try {
        // `withTransaction` rather than an explicit start/commit pair: it
        // replays the callback when the server reports a transient error, which
        // is exactly what a write conflict on a per-table counter document
        // produces when two creates allocate ids at once. Reproducing that by
        // hand would mean re-running caller code from inside this method.
        return await session.withTransaction!(() => callback(txClient), {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
        });
      } catch (error) {
        throw this.explainMongoTransactionFailure(error);
      } finally {
        // The session is a server-side resource and leaks if it is not ended,
        // whether the transaction committed or not.
        try {
          await session.endSession?.();
        } catch (endError) {
          this.logger.logError(endError as Error);
        }
      }
    }

    if (this.config.type === DBType.MSSQL) {
      // SQL Server has no `BEGIN`/`COMMIT` text: the transaction is a
      // server-side object opened on a borrowed pooled connection, and every
      // statement inside it has to be sent through a `Request` built from that
      // object. `Database` cannot appear here, so the pool handle is safe to
      // treat as a pool — the constructor marks a transaction-bound client and
      // the guard above returns early for it.
      await this.ensureMSSQLConnected();
      const transaction = new sql.Transaction(this.client as any);
      const txClient = new DBClient(this.config, this.logger, transaction);
      this.logger.logDebug("Starting MSSQL transaction.");
      await transaction.begin();
      try {
        const result = await callback(txClient);
        await transaction.commit();
        return result;
      } catch (error) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          this.logger.logError(rollbackError as Error);
        }
        throw error;
      }
      // Nothing to release: unlike the pg and mysql pools, mssql returns the
      // borrowed connection to the pool as part of commit/rollback.
    }

    if (isMySQLPool(this.client)) {
      const connection = await this.client.getConnection();
      const txClient = new DBClient(this.config, this.logger, connection);
      this.logger.logDebug("Starting MySQL transaction.");
      try {
        await txClient.query("START TRANSACTION");
        const result = await callback(txClient);
        await txClient.query("COMMIT");
        return result;
      } catch (error) {
        await txClient.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
        this.logger.logDebug("MySQL transaction connection released.");
      }
    }

    if (this.client instanceof Pool) {
      const connection = await this.client.connect();
      const txClient = new DBClient(this.config, this.logger, connection);
      this.logger.logDebug("Starting Postgres transaction.");
      try {
        await txClient.migrationQuery("BEGIN");
        const result = await callback(txClient);
        await txClient.migrationQuery("COMMIT");
        return result;
      } catch (error) {
        await txClient.migrationQuery("ROLLBACK");
        throw error;
      } finally {
        connection.release();
        this.logger.logDebug("Postgres transaction connection released.");
      }
    }

    throw new StabilizeError(
      "Transaction not supported by this client configuration.",
      "TX_ERROR",
    );
  }

  /**
   * Closes the database connection.
   * For pooled connections, ends the pool.
   * @returns Promise that resolves once the connection is closed.
   */
  async close() {
    if (this.client instanceof Database) {
      this.client.close();
    } else if (
      this.config.type === DBType.MSSQL &&
      this.client &&
      "close" in this.client
    ) {
      // An mssql pool is torn down with `close()`, not the `end()` the pg and
      // mysql pools expose — the generic branch below would silently skip it
      // and leave the sockets open.
      await (this.client as MSSQLHandle).close!();
    } else if (
      this.config.type === DBType.MongoDB &&
      this.client &&
      typeof (this.client as MongoHandle).close === "function"
    ) {
      // Same trap as mssql: a `MongoClient` is closed with `close()`. A client
      // that was never used holds no handle at all, so the guard is on the
      // function rather than the config.
      await (this.client as MongoHandle).close!();
    } else if (this.client && "end" in this.client) {
      await (this.client as any).end();
    }
    this.client = null!;
    this.mongoConnectPromise = null;
    this.logger.logInfo("Database connection closed");
  }

  async queryExec(
    query: string,
    params: any[] = [],
  ): Promise<{ affectedRows: number }> {
    if (this.config.type === DBType.MongoDB) this.rejectSQLForMongo();
    const start = Date.now();
    let affectedRows = 0;

    if (this.client instanceof Database) {
      const result = this.client.run(query, ...params);
      affectedRows = result.changes;
    } else if (this.config.type === DBType.MySQL) {
      const [mysqlResult] = await (this.client as mysql.Pool).query(
        query,
        bindMySQLParams(params),
      );
      affectedRows = (mysqlResult as any).affectedRows ?? 0;
    } else if (this.config.type === DBType.Postgres) {
      const pgResult = await (this.client as Pool).query(
        rewritePlaceholders(query, DBType.Postgres),
        params,
      );
      affectedRows = pgResult.rowCount ?? 0;
    } else if (this.config.type === DBType.MSSQL) {
      const mssqlResult = await this.runMSSQL(query, params);
      // mssql reports one entry per statement in the batch, so the first is the
      // count for the statement that was sent.
      affectedRows = mssqlResult.rowsAffected?.[0] ?? 0;
    }

    const executionTime = Date.now() - start;
    this.logger.logQuery(query, params, executionTime);
    return { affectedRows };
  }

  /**
   * Executes a migration query (DDL or DML statement) without returning results.
   * Handles parameterized queries and statement preparation.
   * @param query The SQL query string.
   * @param params Query parameters.
   * @returns Promise that resolves once the query is complete.
   */
  async migrationQuery(query: string, params: any[] = []): Promise<void> {
    if (this.config.type === DBType.MongoDB) this.rejectSQLForMongo();
    const start = Date.now();
    if (this.client instanceof Database) {
      let stmt = this.preparedStatements.get(query);
      if (!stmt) {
        stmt = this.client.prepare(query);
        this.preparedStatements.set(query, stmt);
      }
      stmt.run(...params);
    } else if (this.config.type === DBType.MySQL) {
      await (this.client as mysql.Pool).query(query, bindMySQLParams(params));
    } else if (this.config.type === DBType.Postgres) {
      await (this.client as Pool).query(
        rewritePlaceholders(query, DBType.Postgres),
        params,
      );
    } else if (this.config.type === DBType.MSSQL) {
      await this.runMSSQL(query, params);
    }

    const executionTime = Date.now() - start;
    this.logger.logQuery(query, params, executionTime);
  }

  // ---------------------------------------------------------------------------
  // MongoDB executors
  //
  // A parallel family to query/queryExec/migrationQuery rather than a fifth
  // branch inside them: those take a SQL string to dispatch on, and a mongo
  // command is a document. Everything below funnels through `mongoRun` so that
  // logging, session threading and error wrapping are written once.
  //
  // Reads are not retried the way `query` retries them. A transaction is
  // already replayed wholesale by `withTransaction`, and outside one a mongo
  // read failure is a topology problem that retrying three times will not fix.
  // ---------------------------------------------------------------------------

  /**
   * Runs one mongo operation against a collection.
   *
   * @param label Short description used in logs and error messages.
   * @param detail The filter, document or pipeline, for the log line.
   * @param operation Receives the connected database handle.
   * @returns Whatever the operation resolved to.
   * @throws StabilizeError wrapping any driver failure.
   */
  private async mongoRun<T>(
    label: string,
    detail: unknown,
    operation: (db: MongoDbHandle) => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    try {
      const db = await this.mongoDb();
      const result = await operation(db);
      this.logger.logQuery(label, [detail], Date.now() - start);
      return result;
    } catch (error) {
      if (error instanceof StabilizeError) throw error;
      this.logger.logError(error as Error);
      throw new StabilizeError(
        `MongoDB ${label} failed: ${(error as Error).message}`,
        "MONGO_ERROR",
        error as Error,
      );
    }
  }

  /**
   * Resolves a collection, or throws if the handle has none.
   * @param name The collection name.
   * @param db The database handle.
   */
  private mongoCollection(
    name: string,
    db: MongoDbHandle,
  ): MongoCollectionHandle {
    const collection = db.collection?.(name);
    if (!collection) {
      throw new StabilizeError(
        `MongoDB database handle did not provide collection '${name}'.`,
        "MONGO_ERROR",
      );
    }
    return collection;
  }

  /** Merges caller options with this client's session, when it has one. */
  private withSession(
    options: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { ...options, ...this.mongoOptions() };
  }

  /** Reads every matching document. */
  async mongoFind(
    collection: string,
    filter: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<any[]> {
    return this.mongoRun("find", { collection, filter }, async (db) => {
      const cursor = this.mongoCollection(collection, db).find(
        filter,
        this.withSession(options),
      );
      return (await cursor.toArray()) ?? [];
    });
  }

  /** Reads the first matching document, or null. */
  async mongoFindOne(
    collection: string,
    filter: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<any | null> {
    return this.mongoRun("findOne", { collection, filter }, async (db) =>
      this.mongoCollection(collection, db).findOne(
        filter,
        this.withSession(options),
      ),
    );
  }

  /** Inserts one document. */
  async mongoInsertOne(
    collection: string,
    document: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResult> {
    return this.mongoRun("insertOne", { collection }, async (db) =>
      this.mongoCollection(collection, db).insertOne(
        document,
        this.withSession(options),
      ),
    );
  }

  /**
   * Inserts many documents.
   *
   * `ordered: false` is deliberately *not* the default: a batch that fails
   * halfway should leave the caller able to tell which half landed, and an
   * unordered insert reports that only in aggregate.
   */
  async mongoInsertMany(
    collection: string,
    documents: Record<string, unknown>[],
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResult> {
    return this.mongoRun("insertMany", { collection, count: documents.length }, async (db) =>
      this.mongoCollection(collection, db).insertMany(
        documents,
        this.withSession(options),
      ),
    );
  }

  /** Updates the first matching document. */
  async mongoUpdateOne(
    collection: string,
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResult> {
    return this.mongoRun("updateOne", { collection, filter }, async (db) =>
      this.mongoCollection(collection, db).updateOne(
        filter,
        update,
        this.withSession(options),
      ),
    );
  }

  /** Updates every matching document. */
  async mongoUpdateMany(
    collection: string,
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResult> {
    return this.mongoRun("updateMany", { collection, filter }, async (db) =>
      this.mongoCollection(collection, db).updateMany(
        filter,
        update,
        this.withSession(options),
      ),
    );
  }

  /** Deletes the first matching document. */
  async mongoDeleteOne(
    collection: string,
    filter: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResult> {
    return this.mongoRun("deleteOne", { collection, filter }, async (db) =>
      this.mongoCollection(collection, db).deleteOne(
        filter,
        this.withSession(options),
      ),
    );
  }

  /** Deletes every matching document. */
  async mongoDeleteMany(
    collection: string,
    filter: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResult> {
    return this.mongoRun("deleteMany", { collection, filter }, async (db) =>
      this.mongoCollection(collection, db).deleteMany(
        filter,
        this.withSession(options),
      ),
    );
  }

  /** Counts matching documents without materialising them. */
  async mongoCount(
    collection: string,
    filter: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<number> {
    return this.mongoRun("countDocuments", { collection, filter }, async (db) =>
      this.mongoCollection(collection, db).countDocuments(
        filter,
        this.withSession(options),
      ),
    );
  }

  /** Lists the distinct values of a field. */
  async mongoDistinct(
    collection: string,
    field: string,
    filter: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): Promise<any[]> {
    return this.mongoRun("distinct", { collection, field }, async (db) =>
      this.mongoCollection(collection, db).distinct(
        field,
        filter,
        this.withSession(options),
      ),
    );
  }

  /** Runs an aggregation pipeline. */
  async mongoAggregate(
    collection: string,
    pipeline: Record<string, unknown>[],
    options: Record<string, unknown> = {},
  ): Promise<any[]> {
    return this.mongoRun("aggregate", { collection, stages: pipeline.length }, async (db) => {
      const cursor = this.mongoCollection(collection, db).aggregate(
        pipeline,
        this.withSession(options),
      );
      return (await cursor.toArray()) ?? [];
    });
  }

  /**
   * Applies an update and returns a document.
   *
   * The driver returns the document itself, not a `ModifyResult`, because
   * `includeResultMetadata` has defaulted to false since driver 6 (NODE-3568).
   * The return shape is whatever `returnDocument` asks for, so this deliberately
   * does not normalise it — the caller that needs `$inc`'s new value and the one
   * that needs the pre-image want different answers.
   */
  async mongoFindOneAndUpdate(
    collection: string,
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<any> {
    return this.mongoRun("findOneAndUpdate", { collection, filter }, async (db) =>
      this.mongoCollection(collection, db).findOneAndUpdate(
        filter,
        update,
        this.withSession(options),
      ),
    );
  }

  /** Runs a bulk write, for counter bumps and M2M syncs that need one trip. */
  async mongoBulkWrite(
    collection: string,
    operations: Record<string, unknown>[],
    options: Record<string, unknown> = {},
  ): Promise<MongoUpdateResult> {
    return this.mongoRun("bulkWrite", { collection, count: operations.length }, async (db) =>
      this.mongoCollection(collection, db).bulkWrite(
        operations,
        this.withSession(options),
      ),
    );
  }

  /** Creates an index. */
  async mongoCreateIndex(
    collection: string,
    spec: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.mongoRun("createIndex", { collection, spec }, async (db) =>
      this.mongoCollection(collection, db).createIndex(
        spec,
        this.withSession(options),
      ),
    );
  }

  /** Lists a collection's indexes. */
  async mongoListIndexes(collection: string): Promise<any[]> {
    return this.mongoRun("listIndexes", { collection }, async (db) => {
      const cursor = this.mongoCollection(collection, db).listIndexes();
      return (await cursor.toArray()) ?? [];
    });
  }

  /** Lists a database's collections. */
  async mongoListCollections(): Promise<any[]> {
    return this.mongoRun("listCollections", {}, async (db) => {
      const cursor = db.listCollections?.();
      if (!cursor) return [];
      return (await cursor.toArray()) ?? [];
    });
  }

  /**
   * Runs a database command.
   *
   * The catch-all for operations with no collection to hang off — `collMod` to
   * change a validator, `ping` for the health check, `hello` for topology.
   *
   * The command and the options are separate arguments, and the session belongs
   * in the second: merged into the command document it becomes a field the
   * server tries to serialise, and a `ClientSession` is not BSON.
   */
  async mongoCommand(
    command: Record<string, unknown>,
  ): Promise<any> {
    return this.mongoRun("command", command, async (db) => {
      if (!db.command) {
        throw new StabilizeError(
          "MongoDB database handle did not provide command().",
          "MONGO_ERROR",
        );
      }
      return db.command(command, this.mongoOptions());
    });
  }
}
