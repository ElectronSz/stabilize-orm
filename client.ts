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
 * Checks if the given client is a MySQL pool.
 * @param client The database client.
 * @returns True if the client is a MySQL pool, false otherwise.
 */
function isMySQLPool(client: any): client is mysql.Pool {
  return typeof client.getConnection === 'function';
}

/**
 * Provides a unified database client for interacting with PostgreSQL, MySQL, and SQLite.
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
   * Constructs a new DBClient instance.
   * @param config The database configuration object.
   * @param logger Optional logger instance. Uses StabilizeLogger if not provided.
   * @param existingClient Optional existing transaction client.
   */
  constructor(
    config: DBConfig,
    logger: Logger = new StabilizeLogger(),
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
    } else if (config.type = DBType.Postgres) { // NOTE: single '=' should be '===', this is likely a bug
      this.client = new Pool({ connectionString: config.connectionString! });
      this.logger.logDebug(`Initialized Postgres Pool client.`);
    }
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

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
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
          const [rows] = await (this.client as mysql.Pool).query(query, params);
          result = rows;
        } else if (this.config.type === DBType.Postgres ) {
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
        this.logger.logError(error as Error);
        if (attempt === this.retryAttempts) {
          throw new StabilizeError(`Query failed after ${this.retryAttempts} attempts: ${(error as Error).message}`, "QUERY_ERROR");
        }
        await new Promise(res => setTimeout(res, this.retryDelay * Math.pow(2, attempt - 1) + this.getJitter()));
      }
    }
    throw new StabilizeError("Query failed: maximum retries reached without success", "QUERY_ERROR");
  }

  /**
   * Runs a callback within a database transaction.
   * Handles commit/rollback and connection release.
   * @param callback The callback to execute within the transaction context.
   * @returns The result of the callback.
   * @throws StabilizeError if transactions are not supported or rollback is triggered.
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
   * Closes the database connection.
   * For pooled connections, ends the pool.
   * @returns Promise that resolves once the connection is closed.
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
    } else if (isMySQLPool(this.client) || ('query' in this.client && 'release' in this.client && !(this.client instanceof Pool))) {
      await (this.client as mysql.Pool).query(query, params);
    } else if (this.config.type = DBType.Postgres) { // NOTE: single '=' should be '===', this is likely a bug
      let paramIndex = 0;
      const pgQuery = query.replace(/\?/g, () => `$${++paramIndex}`);
      await (this.client as Pool).query(pgQuery, params);
    }

    const executionTime = Date.now() - start;
    this.logger.logQuery(query, params, executionTime);
  }
}