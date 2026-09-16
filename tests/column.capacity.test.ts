import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";
import { mapDataTypeToSql } from "../migrations";

/**
 * `length`, `precision` and `scale` on `ColumnConfig`.
 *
 * All three were declared and read by nothing: the SQL type came from the
 * `DataTypes` member alone, so `{ type: DataTypes.STRING, length: 50 }` emitted
 * `VARCHAR(255)` on MySQL and a 200-character value was stored without
 * complaint. These cover both halves of the fix — the type the mapper emits and
 * the check the repository runs — plus the guarantee that made the change safe
 * to make: a column that declares none of the three is unaffected.
 */

describe("mapDataTypeToSql with column options", () => {
  it("narrows the string type where the dialect has a width", () => {
    expect(
      mapDataTypeToSql(DataTypes.STRING, DBType.MySQL, { length: 50 }),
    ).toBe("VARCHAR(50)");
    expect(
      mapDataTypeToSql(DataTypes.STRING, DBType.MSSQL, { length: 50 }),
    ).toBe("NVARCHAR(50)");
  });

  it("leaves the unbounded dialects alone rather than faking a width", () => {
    // Postgres `TEXT` and `VARCHAR(n)` are the same type, and SQLite's declared
    // type is a type-affinity hint rather than a constraint. Emitting a width
    // here would read as enforcement and behave as decoration; the limit is
    // enforced in process instead.
    expect(
      mapDataTypeToSql(DataTypes.STRING, DBType.Postgres, { length: 50 }),
    ).toBe("TEXT");
    expect(mapDataTypeToSql(DataTypes.STRING, DBType.SQLite, { length: 50 })).toBe(
      "TEXT",
    );
  });

  it("carries a declared precision and scale into DECIMAL", () => {
    for (const dialect of [
      DBType.Postgres,
      DBType.MySQL,
      DBType.MSSQL,
    ]) {
      expect(
        mapDataTypeToSql(DataTypes.DECIMAL, dialect, {
          precision: 12,
          scale: 4,
        }),
      ).toBe("DECIMAL(12,4)");
    }
  });

  it("takes a single-precision width where the dialect supports one", () => {
    expect(
      mapDataTypeToSql(DataTypes.FLOAT, DBType.MySQL, { precision: 10 }),
    ).toBe("FLOAT(10)");
  });

  it("rejects options no dialect would accept rather than emitting them", () => {
    // `VARCHAR(NaN)` is a syntax error the caller would meet at migration time,
    // far from the model that caused it. A scale wider than the precision is
    // refused by every server, so it falls back instead of being interpolated.
    expect(mapDataTypeToSql(DataTypes.STRING, DBType.MySQL, { length: 0 })).toBe(
      "VARCHAR(255)",
    );
    expect(
      mapDataTypeToSql(DataTypes.STRING, DBType.MySQL, { length: -1 }),
    ).toBe("VARCHAR(255)");
    expect(
      mapDataTypeToSql(DataTypes.STRING, DBType.MySQL, {
        length: 2.5,
      }),
    ).toBe("VARCHAR(255)");
    expect(
      mapDataTypeToSql(DataTypes.DECIMAL, DBType.MySQL, {
        precision: 2,
        scale: 5,
      }),
    ).toBe("DECIMAL(2,2)");
  });

  it("shrinks the default scale to fit a narrow precision", () => {
    // `DECIMAL(1,2)` is rejected by every server, so the library's usual scale
    // of 2 gives way rather than being applied blindly.
    expect(
      mapDataTypeToSql(DataTypes.DECIMAL, DBType.MySQL, { precision: 1 }),
    ).toBe("DECIMAL(1,1)");
    expect(
      mapDataTypeToSql(DataTypes.DECIMAL, DBType.MySQL, { precision: 4 }),
    ).toBe("DECIMAL(4,2)");
  });

  it("emits exactly what it always did when no options are declared", () => {
    // The change added an optional parameter, and this is the contract that
    // made it a safe one: every existing caller passes two arguments.
    expect(mapDataTypeToSql(DataTypes.STRING, DBType.MySQL)).toBe("VARCHAR(255)");
    expect(mapDataTypeToSql(DataTypes.STRING, DBType.MSSQL)).toBe(
      "NVARCHAR(255)",
    );
    expect(mapDataTypeToSql(DataTypes.DECIMAL, DBType.MySQL)).toBe(
      "DECIMAL(10,2)",
    );
    expect(mapDataTypeToSql(DataTypes.DECIMAL, DBType.SQLite)).toBe("NUMERIC");
    expect(mapDataTypeToSql("somethingelse", DBType.MSSQL)).toBe(
      "NVARCHAR(MAX)",
    );
  });
});

describe("length, precision and scale are enforced on write", () => {
  const Widget = defineModel({
    tableName: "capacity_widgets",
    columns: {
      id: { type: DataTypes.INTEGER, required: true },
      code: { type: DataTypes.STRING, length: 50 },
      amount: { type: DataTypes.DECIMAL, precision: 5, scale: 2 },
      label: { type: DataTypes.STRING, maxLength: 10 },
    },
  });

  let db: any;
  let repo: any;

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Widget]);
    repo = db.getRepository(Widget);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("rejects a string longer than its declared length", async () => {
    await expect(repo.create({ code: "x".repeat(200) })).rejects.toThrow(
      /too long/,
    );
    // The boundary itself is allowed — this is a `>` and not a `>=`.
    const exact = await repo.create({ code: "x".repeat(50) });
    expect(exact.code).toHaveLength(50);
  });

  it("still honours maxLength, which keeps its own meaning", async () => {
    await expect(repo.create({ label: "x".repeat(11) })).rejects.toThrow(
      /too long/,
    );
    expect((await repo.create({ label: "x".repeat(10) })).label).toHaveLength(10);
  });

  it("rejects a value carrying more fractional digits than scale", async () => {
    await expect(repo.create({ amount: 1.005 })).rejects.toThrow(
      /decimal place/,
    );
  });

  it("rejects a value with more integer digits than precision leaves", async () => {
    await expect(repo.create({ amount: 1234.56 })).rejects.toThrow(
      /integer digit/,
    );
  });

  it("accepts ordinary decimal values without mistaking float noise for excess", async () => {
    // `(0.1).toFixed(2)` is `"0.10"`, so the check rounds rather than reading
    // the binary expansion — otherwise every `DECIMAL` column would reject the
    // first value written to it.
    for (const amount of [123.45, 0.1, 0, 999.99]) {
      const row = await repo.create({ amount });
      expect(row.amount).toBeDefined();
    }
  });

  it("does not apply a precision check to a column that declares none", async () => {
    const plain = await repo.create({ code: "anything at all" });
    expect(plain.code).toBe("anything at all");
  });

  it("checks against the same scale the DDL was built with", async () => {
    // A precision declared without a scale is typed `DECIMAL(5,2)`, so the
    // write-time check has to allow two decimal places. Reading the capacity
    // from anywhere but `resolveDecimalCapacity` is how these two drifted
    // apart once already — a column typed `DECIMAL(5,2)` that rejected its own
    // second decimal place.
    const Typed = defineModel({
      tableName: "capacity_typed",
      columns: {
        id: { type: DataTypes.INTEGER, required: true },
        amount: { type: DataTypes.DECIMAL, precision: 5 },
      },
    });
    const typedDb: any = new Stabilize({
      type: DBType.SQLite,
      connectionString: ":memory:",
    });
    await typedDb.autoMigrate([Typed]);
    const typedRepo = typedDb.getRepository(Typed);

    try {
      expect((await typedRepo.create({ amount: 123.45 })).amount).toBeDefined();
      await expect(typedRepo.create({ amount: 1234.56 })).rejects.toThrow(
        /integer digit/,
      );
    } finally {
      await typedDb.close();
    }
  });
});
