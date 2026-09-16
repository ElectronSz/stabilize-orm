/**
 * @file mssql.d.ts
 * @description Minimal ambient types for the `mssql` driver.
 *
 * `mssql` ships no declarations of its own, and taking `@types/mssql` as a
 * dependency would leave every consumer of the published package needing it
 * too. Only the surface the client actually touches is declared, in the same
 * spirit as `bun-sqlite.d.ts`.
 */

declare module "mssql" {
  namespace sql {
    /** A pool of connections to one SQL Server instance. */
    class ConnectionPool {
      constructor(config: string | Record<string, any>);
      connect(): Promise<ConnectionPool>;
      close(): Promise<void>;
      request(): Request;
      readonly connected: boolean;
      readonly size: number;
      readonly available: number;
      readonly pending: number;
      readonly borrowed: number;
    }

    /** A server-side transaction, opened on a borrowed pooled connection. */
    class Transaction {
      constructor(pool: ConnectionPool);
      begin(isolationLevel?: number): Promise<void>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
    }

    /** One batch of statements, bound to a pool or to an open transaction. */
    class Request {
      constructor(parent?: ConnectionPool | Transaction);
      input(name: string, value: any): Request;
      input(name: string, type: any, value: any): Request;
      query(command: string): Promise<{
        recordset: any[];
        recordsets: any[][];
        rowsAffected: number[];
        output: Record<string, any>;
      }>;
    }

    /** Concrete data-type markers accepted by `Request.input`. */
    const NVarChar: any;
  }

  export = sql;
}
