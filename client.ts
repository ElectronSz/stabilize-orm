import { sql, SQL } from "bun";
import { Database, Statement } from "bun:sqlite";
import {
  type DBConfig,
  StabilizeError,
  type PoolMetrics,
  DBType,
} from "./types";
import { type Logger, ConsoleLogger } from "./logger";

function isSQLiteConfig(config: DBConfig): boolean {
  return (
    config.type === DBType.SQLite || config.connectionString.includes("sqlite")
  );
}

export class DBClient {
  private client: Database | any | null = null;
  private logger: Logger;
  private retryAttempts: number;
  private retryDelay: number;
  private maxJitter: number;

  private preparedStatements: Map<string, Statement> = new Map();
  private config: DBConfig;

  constructor(config: DBConfig, logger: Logger = new ConsoleLogger()) {
    this.config = config;
    this.logger = logger;
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.maxJitter = config.maxJitter || 100;

    this.initializeClient(config);
  }

  private initializeClient(config: DBConfig) {
    if (isSQLiteConfig(config)) {
      try {
        // new Database(path, { create: true }) is the standard Bun method
        this.client = new Database(config.connectionString, { create: true });
        this.logger.logDebug(
          `Initialized Bun SQLite client for: ${config.connectionString}`,
        );
      } catch (e) {
        this.logger.logError(e as Error);
        throw new StabilizeError(
          `Failed to initialize SQLite database: ${(e as Error).message}`,
          "INIT_ERROR",
        );
      }
    } else {
      this.client = new SQL(config.connectionString);
      this.logger.logDebug(
        `Initialized Bun SQL client for: ${config.connectionString}`,
      );
    }
  }

  private getJitter() {
    return Math.random() * this.maxJitter;
  }

  getPoolMetrics(): PoolMetrics {
    return {
      activeConnections: 0,
      idleConnections: 0,
      totalConnections: this.client instanceof Database ? 1 : 0,
    };
  }

  async switchConnection(config: DBConfig) {
    await this.close();
    this.config = config;
    this.preparedStatements.clear();
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.maxJitter = config.maxJitter || 100;
    this.initializeClient(config);
  }

  async query<T>(query: string, params: any[] = []): Promise<T[]> {
    const start = Date.now();
    this.logger.logQuery(query, params);
    this.logger.logMetrics(this.getPoolMetrics());

    let stmt: Statement | undefined;

    // Check for Bun SQLite client
    if (this.client instanceof Database) {
      const stmtKey = query;
      // Use prepared statement caching for SQLite
      if (!this.preparedStatements.has(stmtKey)) {
        // Use this.client (the Database instance) to prepare the statement
        this.preparedStatements.set(stmtKey, this.client.prepare(query));
      }
      stmt = this.preparedStatements.get(stmtKey);
    }

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        let result: T[];

        if (stmt) {
          result = stmt.all(...params) as T[];
        } else if (this.client) {
              result = (await (this.client as any).unsafe(query, params)) as T[];
        } else {
          throw new StabilizeError(
            "Database client is not initialized or does not support query execution.",
            "INIT_ERROR",
          );
        }

        const executionTime = Date.now() - start;
        this.logger.logQuery(query, params, executionTime);
        return result;
      } catch (error) {
        this.logger.logError(error as Error);
        if (attempt === this.retryAttempts) {
          throw new StabilizeError(
            `Query failed after ${this.retryAttempts} attempts: ${(error as Error).message}`,
            "QUERY_ERROR",
          );
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            this.retryDelay * Math.pow(2, attempt - 1) + this.getJitter(),
          ),
        );
      }
    }
    throw new StabilizeError("Query failed: no attempts made", "QUERY_ERROR");
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    if (this.client instanceof Database) {
      const start = Date.now();
      this.logger.logDebug("Starting native SQLite transaction");

      const tx = this.client.transaction(async () => {
        return callback();
      });

      try {
        const result = await tx();
        this.logger.logDebug(
          `Native transaction committed in ${Date.now() - start}ms`,
        );
        return result;
      } catch (error) {
        this.logger.logError(error as Error);
        throw new StabilizeError(
          `Native transaction failed: ${(error as Error).message}`,
          "TX_ERROR",
        );
      }
    }

    const start = Date.now();
    this.logger.logDebug("Starting manual transaction (non-SQLite)");
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
          await this.query("BEGIN", []);
        const result = await callback();
        await this.query("COMMIT", []);
        this.logger.logDebug(
          `Manual transaction committed in ${Date.now() - start}ms`,
        );
        return result;
      } catch (error) {
        await this.query("ROLLBACK", []).catch(() => {
          this.logger.logDebug("Rollback failed. Connection may be invalid.");
        });
        this.logger.logError(error as Error);
        if (attempt === this.retryAttempts) {
          throw new StabilizeError(
            `Manual transaction failed after ${this.retryAttempts} attempts: ${(error as Error).message}`,
            "TX_ERROR",
          );
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            this.retryDelay * Math.pow(2, attempt - 1) + this.getJitter(),
          ),
        );
      }
    }
    throw new StabilizeError(
      "Transaction failed: no attempts made",
      "TX_ERROR",
    );
  }

  async savepoint<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.logger.logDebug(`Starting savepoint ${name}`);
    await this.query(`SAVEPOINT ${name}`, []);
    try {
      const result = await callback();
      await this.query(`RELEASE SAVEPOINT ${name}`, []);
      this.logger.logDebug(
        `Savepoint ${name} released in ${Date.now() - start}ms`,
      );
      return result;
    } catch (error) {
      await this.query(`ROLLBACK TO SAVEPOINT ${name}`, []).catch(() => {
        this.logger.logDebug(
          `Rollback to savepoint ${name} failed. Connection may be invalid.`,
        );
      });
      this.logger.logError(error as Error);
      throw error;
    }
  }

  async close() {
    this.preparedStatements.clear();
      if (this.client instanceof Database) {
      this.client.close();
      this.client = null;
    } else if (
      this.client &&
      typeof (this.client as any).close === "function"
    ) {
      await (this.client as any).close();
      this.client = null;
    }
    this.logger.logInfo("Database connection closed");
  }
}
