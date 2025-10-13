import { sql, SQL } from 'bun';
import { Database, Statement } from 'bun:sqlite';
import {
  type DBConfig,
  StabilizeError,
  type PoolMetrics,
  DBType, // Added DBType for type checking
  type LoggerConfig, // Kept, but not used in logic
} from './types';
import { type Logger, ConsoleLogger } from './logger';

// Helper to determine if we are in Bun SQLite mode based on config
function isSQLiteConfig(config: DBConfig): boolean {
  return config.type === DBType.SQLite || config.connectionString.includes('sqlite');
}

export class DBClient {
  // Renamed to 'client' for clarity; stores the actual connection (Bun.Database or external driver)
  // We use 'any' for the SQL client instance since Bun's SQL client is complex (callable function with methods)
  private client: Database | any | null = null;
  private logger: Logger;
  private retryAttempts: number;
  private retryDelay: number;
  private maxJitter: number;
  // Map stores Bun SQLite Statement objects when in SQLite mode
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

  // Initializes the connection based on config
  private initializeClient(config: DBConfig) {
    if (isSQLiteConfig(config)) {
      // Use Bun's native SQLite client, which is synchronous to construct
      try {
        // new Database(path, { create: true }) is the standard Bun method
        this.client = new Database(config.connectionString, { create: true });
        this.logger.logDebug(`Initialized Bun SQLite client for: ${config.connectionString}`);
      } catch (e) {
        this.logger.logError(e as Error);
        throw new StabilizeError(`Failed to initialize SQLite database: ${(e as Error).message}`, 'INIT_ERROR');
      }
    } else {
      // For other DB types (Postgres/MySQL), initialize a Bun SQL client instance.
      // This is necessary because the bare `sql` tag is for the default connection, 
      // and we need an instance with specific connection settings, using `SQL` as the constructor.
      this.client = new SQL(config.connectionString);
      this.logger.logDebug(`Initialized Bun SQL client for: ${config.connectionString}`);
    }
  }

  private getJitter() {
    return Math.random() * this.maxJitter;
  }

  // Pool metrics are largely irrelevant for single-connection Bun SQLite
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
          // Bun SQLite Statement objects use .all() for fetching results
          result = stmt.all(...params) as T[];
        } else if (this.client) {
          // Path for non-SQLite Bun SQL clients (Postgres/MySQL)
          // Bun SQL clients do not expose a standard .query() method. 
          // We must use the 'unsafe' helper to execute a raw string query with positional parameters.
          result = (await (this.client as any).unsafe(query, params)) as T[];
        } else {
          throw new StabilizeError('Database client is not initialized or does not support query execution.', 'INIT_ERROR');
        }

        const executionTime = Date.now() - start;
        this.logger.logQuery(query, params, executionTime);
        return result;
      } catch (error) {
        this.logger.logError(error as Error);
        if (attempt === this.retryAttempts) {
          throw new StabilizeError(`Query failed after ${this.retryAttempts} attempts: ${(error as Error).message}`, 'QUERY_ERROR');
        }
        // Exponential backoff with jitter
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt - 1) + this.getJitter()));
      }
    }
    throw new StabilizeError('Query failed: no attempts made', 'QUERY_ERROR');
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    // Use native Bun SQLite transaction wrapper for safer, faster transactions
    if (this.client instanceof Database) {
      const start = Date.now();
      this.logger.logDebug('Starting native SQLite transaction');
      
      // Bun's .transaction() automatically handles BEGIN/COMMIT/ROLLBACK
      const tx = this.client.transaction(async () => {
        return callback();
      });

      try {
        const result = await tx();
        this.logger.logDebug(`Native transaction committed in ${(Date.now() - start)}ms`);
        return result;
      } catch (error) {
        this.logger.logError(error as Error);
        // The transaction automatically rolls back on error
        throw new StabilizeError(`Native transaction failed: ${(error as Error).message}`, 'TX_ERROR');
      }
    }

    // Fallback to manual transaction with retry logic for non-SQLite
    const start = Date.now();
    this.logger.logDebug('Starting manual transaction (non-SQLite)');
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        // Use this.query, which now correctly handles execution via .unsafe() for non-SQLite
        await this.query('BEGIN', []);
        const result = await callback();
        await this.query('COMMIT', []);
        this.logger.logDebug(`Manual transaction committed in ${(Date.now() - start)}ms`);
        return result;
      } catch (error) {
        // Attempt rollback, but ignore errors if rollback fails
        await this.query('ROLLBACK', []).catch(() => { this.logger.logDebug('Rollback failed. Connection may be invalid.'); });
        this.logger.logError(error as Error);
        if (attempt === this.retryAttempts) {
          throw new StabilizeError(`Manual transaction failed after ${this.retryAttempts} attempts: ${(error as Error).message}`, 'TX_ERROR');
        }
        // Exponential backoff with jitter
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempt - 1) + this.getJitter()));
      }
    }
    throw new StabilizeError('Transaction failed: no attempts made', 'TX_ERROR');
  }

  async savepoint<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.logger.logDebug(`Starting savepoint ${name}`);
    await this.query(`SAVEPOINT ${name}`, []);
    try {
      const result = await callback();
      await this.query(`RELEASE SAVEPOINT ${name}`, []);
      this.logger.logDebug(`Savepoint ${name} released in ${(Date.now() - start)}ms`);
      return result;
    } catch (error) {
      // Attempt rollback, but ignore errors if rollback fails
      await this.query(`ROLLBACK TO SAVEPOINT ${name}`, []).catch(() => { this.logger.logDebug(`Rollback to savepoint ${name} failed. Connection may be invalid.`); });
      this.logger.logError(error as Error);
      throw error;
    }
  }

  async close() {
    this.preparedStatements.clear();
    // Check if the client is a Bun Database instance before closing (Bun SQLite close is sync)
    if (this.client instanceof Database) {
      this.client.close();
      this.client = null;
    } else if (this.client && typeof (this.client as any).close === 'function') {
      // Assume external/Bun SQL driver has an async close method
      await (this.client as any).close();
      this.client = null;
    }
    this.logger.logInfo('Database connection closed');
  }
}
