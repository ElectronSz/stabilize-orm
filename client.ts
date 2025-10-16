/**
 * @file client.ts
 * @description Provides a unified database client for interacting with PostgreSQL, MySQL, and SQLite.
 * @author ElectronSz
 */

import { Database, Statement } from "bun:sqlite";
import { Pool, type PoolClient } from "pg";
import mysql from "mysql2/promise";
import {
  type DBConfig,
  StabilizeError,
  DBType,
} from "./types";
import { type Logger, ConsoleLogger } from "./logger";

/** @internal Checks if the config is for SQLite. */
function isSQLiteConfig(config: DBConfig): boolean {
  return config.type === DBType.SQLite;
}

/** @internal Checks if the config is for MySQL. */
function isMySQLConfig(config: DBConfig): boolean {
  return config.type === DBType.MySQL;
}

/** @internal A type guard to reliably identify a mysql2 Pool object. */
function isMySQLPool(client: any): client is mysql.Pool {
  return typeof client.getConnection === 'function';
}

/**
 * A unified database client that provides a consistent interface for
 * PostgreSQL, MySQL, and SQLite databases. It handles connection pooling,
 * query execution with retries, and transactions.
 */
export class DBClient {
  private client!: Database | Pool | mysql.Pool | PoolClient | mysql.PoolConnection;
  private logger: Logger;
  public readonly config: DBConfig;
  private retryAttempts: number;
  private retryDelay: number;
  private maxJitter: number;

  private preparedStatements: Map<string, Statement> = new Map();
  public readonly isTransactionClient: boolean = false;

  /**
   * Creates an instance of DBClient.
   * @param config The database configuration object.
   * @param logger A logger instance for logging messages.
   * @param existingClient An optional existing connection, used internally for transactions.
   */
  constructor(
    config: DBConfig,
    logger: Logger = new ConsoleLogger(),
    existingClient: PoolClient | mysql.PoolConnection | null = null,
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
   * @internal
   * Initializes the database client based on the provided configuration.
   * @param config The database configuration.
   */
  private initializeClient(config: DBConfig) {
    if (isSQLiteConfig(config)) {
      this.client = new Database(config.connectionString, { create: true });
      this.logger.logDebug(`Initialized Bun SQLite client.`);
    } else if (isMySQLConfig(config)) {
      this.client = mysql.createPool(config.connectionString);
      this.logger.logDebug(`Initialized MySQL Pool client.`);
    } else if (config.type = DBType.Postgres) {
      this.client = new Pool({ connectionString: config.connectionString! });
      this.logger.logDebug(`Initialized Postgres Pool client.`);
    }
  }

  /** @internal Gets a random jitter value to add to retry delays. */
  private getJitter = () => Math.random() * this.maxJitter;

  /**
   * Executes a SQL query with parameters and returns the result.
   * Automatically handles placeholder conversion for different databases and includes retry logic.
   * @template T The expected type of the result rows.
   * @param query The SQL query string with `?` as placeholders.
   * @param params An array of parameters to bind to the query.
   * @returns A promise that resolves to an array of results.
   * @example
   * ```
   * const users = await dbClient.query('SELECT * FROM users WHERE status = ?', ['active']);
   * ```
   */

  async query<T>(query: string, params: any[] = []): Promise<T[]> {
    const start = Date.now();

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        let result: any;

        // Log the query before execution
        this.logger.logQuery(query, params);

        if (this.client instanceof Database) { // SQLite
          let stmt = this.preparedStatements.get(query);
          if (!stmt) {
            stmt = this.client.prepare(query);
            this.preparedStatements.set(query, stmt);
          }
          result = stmt.all(...params);
        } else if (this.config.type === DBType.MySQL && isMySQLPool(this.client)) { // MySQL
          const [rows] = await (this.client as mysql.Pool).query(query, params);
          result = rows;
        } else if (this.config.type === DBType.Postgres ) { // Postgres

          let paramIndex = 0;
          const pgQuery = query.replace(/\?/g, () => `$${++paramIndex}`);
          const pgResult = await (this.client as Pool).query(pgQuery, params);
          result = Array.isArray(pgResult.rows) ? pgResult.rows : [];
        } else {
          throw new StabilizeError("Unknown database client type", "QUERY_ERROR");
        }

        const executionTime = Date.now() - start;
        this.logger.logQuery(query, params, executionTime);
        return Array.isArray(result) ? result as T[] : [];
      } catch (error) {
        console.log("error: ", error);

        this.logger.logError(error as Error);
        if (attempt === this.retryAttempts) {
          throw new StabilizeError(`Query failed after ${this.retryAttempts} attempts: ${(error as Error).message}`, "QUERY_ERROR");
        }
        await new Promise(res => setTimeout(res, this.retryDelay * Math.pow(2, attempt - 1) + this.getJitter()));
      }
    }
    // This line should theoretically be unreachable if retryAttempts >= 1
    throw new StabilizeError("Query failed: maximum retries reached without success", "QUERY_ERROR");
  }

  /**
   * Executes a series of database operations within a single atomic transaction.
   * If any operation in the callback fails, the entire transaction is rolled back.
   * @template T The return type of the callback function.
   * @param callback An async function that receives a transactional `DBClient` instance.
   * @returns A promise that resolves with the result of the callback.
   * @example
   * ```
   * await dbClient.transaction(async (txClient) => {
   *   await txClient.query('UPDATE accounts SET balance = balance - 100 WHERE id = 1');
   *   await txClient.query('UPDATE accounts SET balance = balance + 100 WHERE id = 2');
   * });
   * ```
   */
  async transaction<T>(callback: (txClient: DBClient) => Promise<T>): Promise<T> {
    if (this.isTransactionClient) return callback(this);

    if (this.client instanceof Database) {
      const tx = this.client.transaction(() => callback(this));
      return tx();
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

    throw new StabilizeError("Transaction not supported by this client configuration.", "TX_ERROR");
  }

  /**
   * Closes the database connection pool gracefully.
   * Should be called when the application is shutting down.
   */
  async close() {
    if (this.client instanceof Database) {
      this.client.close();
    } else if (this.client && 'end' in this.client) {
      await (this.client as any).end();
    }
    this.client = null!;
    this.logger.logInfo("Database connection closed");
  }

  /**
  * Executes a SQL query for migrations/transactions that
  * does NOT expect any result rows and returns void.
  * This is used for DDL and transaction statements (e.g. CREATE TABLE, BEGIN, COMMIT)
  * that should never be iterated over.
  *
  * Logs the execution time for each query.
  *
  * @param query The SQL query string with `?` as placeholders.
  * @param params An array of parameters to bind to the query.
  * @returns A promise that resolves when the query has executed.
  * @example
  * ```
  * await dbClient.migrationQuery('CREATE TABLE ...');
  * await dbClient.migrationQuery('BEGIN');
  * await dbClient.migrationQuery('COMMIT');
  * ```
  */
  async migrationQuery(query: string, params: any[] = []): Promise<void> {
    const start = Date.now();
    this.logger.logQuery(query, params);

    if (this.client instanceof Database) { // SQLite
      let stmt = this.preparedStatements.get(query);
      if (!stmt) {
        stmt = this.client.prepare(query);
        this.preparedStatements.set(query, stmt);
      }
      stmt.run(...params);
    } else if (isMySQLPool(this.client) || ('query' in this.client && 'release' in this.client && !(this.client instanceof Pool))) { // mysql2 Pool or Connection
      await (this.client as mysql.Pool).query(query, params);
    } else if (this.config.type = DBType.Postgres) { // Postgres Pool or Client
      let paramIndex = 0;
      const pgQuery = query.replace(/\?/g, () => `$${++paramIndex}`);
      await (this.client as Pool).query(pgQuery, params);
    }

    const executionTime = Date.now() - start;
    this.logger.logQuery(query, params, executionTime);
  }

}