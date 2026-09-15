import { describe, it, expect, afterEach } from "vitest";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineModel } from "../model";
import { generateMigration, runMigrations } from "../migrations";
import { DataTypes, DBType } from "../types";
import { DBClient } from "../client";

// `runMigrations` builds its own client from the config and closes it again, so
// the only way to see what it did is to point it at a real database and then
// open that database separately. This used to `vi.mock("../client")` instead,
// but a module mock in Bun's test runner is process-wide: it replaced the client
// for every other test file in the run, and they failed with
// "db.migrationQuery is not a function" against a mock that never had that
// method. A file-backed database tests more and poisons nothing.
const DB_FILE = join(tmpdir(), `stabilize-migrations-${process.pid}.db`);

afterEach(async () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      await unlink(`${DB_FILE}${suffix}`);
    } catch {
      // Not every run leaves every file behind; absence is the goal.
    }
  }
});

describe("generateMigration", () => {
  it("should generate SQLite-specific primary key (AUTOINCREMENT)", async () => {
    const User = defineModel({
      tableName: "users",
      columns: {
        id: { name: "id", type: DataTypes.INTEGER },
        username: {
          name: "user_name",
          type: DataTypes.STRING,
          required: true,
          unique: true,
        },
      },
    });

    const migration = await generateMigration(User, "create_users", DBType.SQLite);

    expect(migration.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT NOT NULL UNIQUE)",
    );
    expect(migration.name).toBe("create_users");
  });

  it("should generate PostgreSQL-specific primary key (SERIAL)", async () => {
    const Product = defineModel({
      tableName: "products",
      columns: {
        id: { name: "id", type: DataTypes.INTEGER },
        title: { name: "title", type: DataTypes.STRING },
      },
    });

    const migration = await generateMigration(Product, "create_products", DBType.Postgres);

    expect(migration.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, title TEXT)",
    );
  });

  it("should include history table for versioned models", async () => {
    const Order = defineModel({
      tableName: "orders",
      versioned: true,
      columns: {
        id: { name: "id", type: DataTypes.INTEGER },
        amount: { name: "amount", type: DataTypes.DECIMAL },
      },
    });

    const migration = await generateMigration(Order, "create_orders", DBType.SQLite);

    expect(migration.up).toHaveLength(2);
    expect(migration.up[1]).toContain("CREATE TABLE IF NOT EXISTS orders_history");
  });

  it("should throw an error if model tableName is missing", async () => {
    class UndecoratedModel {}

    await expect(
      generateMigration(UndecoratedModel, "invalid", DBType.SQLite),
    ).rejects.toThrow("Model not defined with tableName");
  });
});

describe("runMigrations", () => {
  it("should create stabilize_migrations table and run UP scripts for new migrations", async () => {
    const migrations = [
      {
        name: "create_test_table",
        up: ["CREATE TABLE test_table (id INT)"],
        down: ["DROP TABLE test_table"],
      },
    ];

    await runMigrations({ type: DBType.SQLite, connectionString: DB_FILE }, migrations);

    const client = new DBClient({ type: DBType.SQLite, connectionString: DB_FILE });
    try {
      const applied = await client.query<{ name: string }>(
        "SELECT name FROM stabilize_migrations",
      );
      expect(applied.map((row) => row.name)).toEqual(["create_test_table"]);

      const created = await client.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_table'",
      );
      expect(created).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("should not re-apply a migration that is already recorded", async () => {
    const migrations = [
      {
        name: "create_test_table",
        up: ["CREATE TABLE test_table (id INT)"],
        down: ["DROP TABLE test_table"],
      },
    ];

    await runMigrations({ type: DBType.SQLite, connectionString: DB_FILE }, migrations);

    // A migration that ran twice would fail here — the table already exists —
    // so reaching the assertion below is itself part of what is being checked.
    await runMigrations({ type: DBType.SQLite, connectionString: DB_FILE }, migrations);

    const client = new DBClient({ type: DBType.SQLite, connectionString: DB_FILE });
    try {
      const rows = await client.query("SELECT id FROM stabilize_migrations");
      expect(rows).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
