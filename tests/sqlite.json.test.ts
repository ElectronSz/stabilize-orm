import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";
import { bindSQLiteParams } from "../client";

/**
 * JSON values on the SQLite path.
 *
 * `bun:sqlite` binds only strings, numbers, bigints, booleans, `null` and typed
 * arrays. A plain object reached it as **NULL** — no error, the value simply
 * gone — and an array was spread as if it were the parameter list, failing the
 * whole statement with "SQLite query expected 1 values, received 3". MySQL and
 * SQL Server already encoded both as JSON text; SQLite did not.
 */

describe("bindSQLiteParams", () => {
  it("encodes a plain object as JSON text", () => {
    expect(bindSQLiteParams([{ a: 1, nested: { b: 2 } }])).toEqual([
      '{"a":1,"nested":{"b":2}}',
    ]);
  });

  it("encodes an array, which the driver would otherwise spread", () => {
    expect(bindSQLiteParams([[1, 2, 3]])).toEqual(["[1,2,3]"]);
    expect(bindSQLiteParams([[]])).toEqual(["[]"]);
  });

  it("leaves every type the driver can already bind untouched", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const buffer = new Uint8Array([1, 2, 3]);
    const params = ["text", 42, 10n, true, false, null, date, buffer];

    const bound = bindSQLiteParams(params);

    expect(bound[0]).toBe("text");
    expect(bound[1]).toBe(42);
    expect(bound[2]).toBe(10n);
    expect(bound[3]).toBe(true);
    expect(bound[4]).toBe(false);
    expect(bound[5]).toBeNull();
    // A `Date` and a typed array carry meaning the driver knows how to encode;
    // stringifying them would silently corrupt the column.
    expect(bound[6]).toBe(date);
    expect(bound[7]).toBe(buffer);
  });

  it("returns a new list rather than mutating the caller's", () => {
    const params = [{ a: 1 }];
    const bound = bindSQLiteParams(params);

    expect(bound).not.toBe(params);
    expect(params[0]).toEqual({ a: 1 });
  });
});

describe("JSON columns round-trip through SQLite", () => {
  const Doc = defineModel({
    tableName: "json_docs",
    versioned: true,
    columns: {
      id: { type: DataTypes.INTEGER, required: true },
      meta: { type: DataTypes.JSON },
      tags: { type: DataTypes.JSON },
    },
  });

  let db: any;
  let repo: any;

  /** Reads the stored column back without the ORM's own write path in the way. */
  const stored = (table: string, column: string, id: number) =>
    db
      .rawQuery(
        `SELECT ${column} AS value, typeof(${column}) AS kind FROM ${table} WHERE id = ?`,
        [id],
      )
      .then((rows: any[]) => rows[0]);

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Doc]);
    repo = db.getRepository(Doc);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("stores an object as JSON text instead of NULL", async () => {
    const row = await repo.create({ meta: { a: 1, nested: { b: 2 } } });

    const cell = await stored("json_docs", "meta", row.id);
    expect(cell.kind).toBe("text");
    expect(JSON.parse(cell.value)).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("stores an array rather than failing the statement", async () => {
    const row = await repo.create({ tags: ["a", "b", "c"] });

    const cell = await stored("json_docs", "tags", row.id);
    expect(cell.kind).toBe("text");
    expect(JSON.parse(cell.value)).toEqual(["a", "b", "c"]);
  });

  it("keeps the JSON in the history table too", async () => {
    // `writeHistory` runs every column through `sanitizeSqlValue`, which used
    // to answer `null` for an object — so a versioned model lost the field in
    // its history on *every* backend, MySQL included, where the live row kept
    // it.
    const row = await repo.create({ meta: { keep: "me" } });

    const history = await db.rawQuery(
      "SELECT meta AS value, typeof(meta) AS kind FROM json_docs_history WHERE id = ?",
      [row.id],
    );

    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe("text");
    expect(JSON.parse(history[0].value)).toEqual({ keep: "me" });
  });

  it("stores a nested array of objects, which is the shape that failed loudest", async () => {
    const row = await repo.create({
      tags: [{ id: 1 }, { id: 2 }],
      meta: { list: [1, [2, [3]]] },
    });

    expect(JSON.parse((await stored("json_docs", "tags", row.id)).value)).toEqual(
      [{ id: 1 }, { id: 2 }],
    );
    expect(JSON.parse((await stored("json_docs", "meta", row.id)).value)).toEqual({
      list: [1, [2, [3]]],
    });
  });

  it("binds a JSON value inside a transaction the same way", async () => {
    let id = 0;
    await db.transaction(async (tx: any) => {
      const row = await repo.create({ meta: { inTx: true } }, {}, tx);
      id = row.id;
    });

    expect(JSON.parse((await stored("json_docs", "meta", id)).value)).toEqual({
      inTx: true,
    });
  });
});
