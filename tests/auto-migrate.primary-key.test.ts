import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * `autoMigrate` used to give *every* model an
 * `INTEGER PRIMARY KEY AUTOINCREMENT` for its `id`, whatever type the model
 * declared. A model with a UUID primary key — the pattern in the README, on
 * the docs site, and what `stabilize-cli generate:model` scaffolds — therefore
 * got an integer column, and every `create({ id: generateUUID() })` failed
 * with "datatype mismatch": SQLite will not store a UUID in a rowid column.
 *
 * The declared type also had to survive: `required` and `unique` were dropped
 * on the `id` branch, leaving the key nullable.
 */

const UuidUser = defineModel({
  tableName: "pk_uuid_users",
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    email: { type: DataTypes.STRING, required: true },
  },
});

const UuidModel = defineModel({
  tableName: "pk_uuid_widgets",
  columns: {
    // The dedicated UUID type maps to a different column per dialect, so it
    // must not take the auto-increment path either.
    id: { type: DataTypes.UUID, required: true },
    label: { type: DataTypes.STRING },
  },
});

const IntModel = defineModel({
  tableName: "pk_int_widgets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING },
  },
});

describe("autoMigrate primary keys", () => {
  let db: any;

  beforeEach(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
  });

  afterEach(async () => {
    await db?.close();
  });

  const columnsOf = async (table: string) =>
    Object.fromEntries(
      (await db.rawQuery(`PRAGMA table_info(${table})`)).map((c: any) => [
        c.name,
        c,
      ]),
    );

  it("keeps a declared STRING id a string, and makes it the primary key", async () => {
    await db.autoMigrate([UuidUser]);
    const id = (await columnsOf("pk_uuid_users")).id;

    expect(id.type).toBe("TEXT");
    expect(id.pk).toBe(1);
    // SQLite allows NULL in a non-integer PRIMARY KEY, so NOT NULL is the only
    // thing that actually enforces `required: true`.
    expect(id.notnull).toBe(1);
  });

  it("creates a row with a UUID id", async () => {
    await db.autoMigrate([UuidUser]);
    const repo = db.getRepository(UuidUser);
    const uuid = "550e8400-e29b-41d4-a716-446655440000";

    // This is the assertion that failed with "datatype mismatch".
    const created: any = await repo.create({ id: uuid, email: "a@b.c" });
    expect(created.id).toBe(uuid);
    expect((await repo.findOne(uuid)).email).toBe("a@b.c");
  });

  it("keeps a declared UUID id a string", async () => {
    await db.autoMigrate([UuidModel]);
    const id = (await columnsOf("pk_uuid_widgets")).id;

    expect(id.type).not.toBe("INTEGER");
    expect(id.pk).toBe(1);
    expect(id.notnull).toBe(1);

    const repo = db.getRepository(UuidModel);
    const uuid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect((await repo.create({ id: uuid, label: "w" })).id).toBe(uuid);
  });

  it("still auto-increments an integer id", async () => {
    await db.autoMigrate([IntModel]);
    const tableSql: string = (
      await db.rawQuery(
        "SELECT sql FROM sqlite_master WHERE name = 'pk_int_widgets'",
      )
    )[0].sql;

    // The original behaviour for an integer key has to be preserved: existing
    // models rely on the database assigning the id.
    expect(tableSql).toMatch(/AUTOINCREMENT/);
    expect((await columnsOf("pk_int_widgets")).id.notnull).toBe(0);

    const repo = db.getRepository(IntModel);
    const created: any = await repo.create({ label: "auto" });
    expect(created.id).toBe(1);
  });

  it("does not alter an existing table's primary key", async () => {
    // AutoMigrate's contract is that it only ever adds. A table created by the
    // old code keeps its integer key, and re-running must not fail on it.
    await db.autoMigrate([UuidUser]);
    await db.rawExec("DROP TABLE pk_uuid_users");
    await db.rawExec(
      "CREATE TABLE pk_uuid_users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)",
    );

    await db.autoMigrate([UuidUser]);
    expect((await columnsOf("pk_uuid_users")).id.type).toBe("INTEGER");
  });
});
