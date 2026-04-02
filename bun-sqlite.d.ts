declare module "bun:sqlite" {
  export class Database {
    constructor(
      filename: string,
      options?: { create?: boolean; readwrite?: boolean },
    );
    prepare(sql: string): Statement;
    run(
      sql: string,
      ...params: any[]
    ): { changes: number; lastInsertRowid: number | bigint };
    query(sql: string, ...params: any[]): any[];
    close(): void;
    transaction(fn: (...args: any[]) => any): Transaction;
    readonly totalChanges: number;
  }

  export class Statement {
    all(...params: any[]): any[];
    run(...params: any[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
    finalize(): void;
  }

  export type Transaction = {
    (...args: any[]): any;
    run(...args: any[]): any;
    immediate(...args: any[]): any;
    exclusive(...args: any[]): any;
  };
}
