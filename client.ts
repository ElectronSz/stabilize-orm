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
 * Provides a unified database client for interacting with PostgreSQL, MySQL, and SQLite.
 */
export class DBClient {
  private client!:
    | Database
    | Pool
    | mysql.Pool
    | PoolClient
    | mysql.PoolConnection
    | MSSQLHandle;
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

  private preparedStatements: Map<string, Statement> = new Map();
  public isTransactionClient: boolean = false;

  /**
   * Constructs a new DBClient instance.
   * @param config The database configuration object.
   * @param logger Optional logger instance. Uses StabilizeLogger if not provided.
   * @param existingClient Optional existing transaction client. For SQL Server
   *   this is the `sql.Transaction` the statements should run inside.
   */
  constructor(
    config: DBConfig,
    logger: Logger = new StabilizeLogger(),
    existingClient:
      | PoolClient
      | mysql.PoolConnection
      | MSSQLHandle
      | null = null,
  ) {
    this.config = config;
    this.logger = logger;
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.maxJitter = config.maxJitter || 100;

    if (existingClient) {
      this.client = existingClient;
      this.isTransactionClient = true;
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
    }
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
    } else if (this.client && "end" in this.client) {
      await (this.client as any).end();
    }
    this.client = null!;
    this.logger.logInfo("Database connection closed");
  }

  async queryExec(
    query: string,
    params: any[] = [],
  ): Promise<{ affectedRows: number }> {
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
}
