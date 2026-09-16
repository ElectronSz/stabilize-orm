/**
 * Ambient declaration for Bun's SQLite driver.
 *
 * `bun:sqlite` is a Bun builtin with no published types, and neither `bun-types`
 * nor `@types/bun` is a dependency here. Taking one would leave every consumer of
 * the published package needing declarations for a runtime it may not use — the
 * same reasoning as `mssql.d.ts`. Only the surface the adapter actually touches
 * is declared.
 *
 * `node:sqlite` deliberately has no declaration here: `@types/node` ships an
 * authoritative one, and declaring it twice produces duplicate-identifier
 * errors. It is a devDependency for exactly that reason.
 *
 * Neither module is imported at runtime — `sqlite-driver.ts` reaches both
 * through `createRequire`, so the module graph carries no `bun:` or
 * `node:sqlite` specifier. These declarations exist so the adapter can be
 * written against real types via `import type`, which the compiler erases.
 */

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
    close(): void;
  }

  export class Statement {
    all(...params: any[]): any[];
    run(...params: any[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  }
}
