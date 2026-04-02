import { describe, it, expect } from "vitest";
import { generateMigration } from "../migrations";
import { DBType, DataTypes } from "../types";
import { defineModel, MetadataStorage } from "../model";

// Define test models
const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    user_name: { type: DataTypes.TEXT, required: true, unique: true },
    created_at: { type: DataTypes.TEXT },
  },
});

const UserSoftDelete = defineModel({
  tableName: "orders",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    user_name: { type: DataTypes.TEXT, required: true, unique: true },
    created_at: { type: DataTypes.TEXT },
    deleted_at: { type: DataTypes.TEXT, softDelete: true },
  },
});

describe("generateMigration", () => {
  it("should generate SQLite-specific primary key (AUTOINCREMENT)", async () => {
    const migration = await generateMigration(
      User,
      "create_users",
      DBType.SQLite,
    );

    expect(migration.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT NOT NULL UNIQUE, created_at TEXT)",
    );
  });

  it("should generate PostgreSQL-specific primary key (SERIAL)", async () => {
    const migration = await generateMigration(
      User,
      "create_users",
      DBType.Postgres,
    );

    expect(migration.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, user_name TEXT NOT NULL UNIQUE, created_at TEXT)",
    );
  });

  it("should generate MySQL-specific primary key (AUTO_INCREMENT)", async () => {
    const migration = await generateMigration(
      User,
      "create_users",
      DBType.MySQL,
    );

    expect(migration.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, user_name TEXT NOT NULL UNIQUE, created_at TEXT)",
    );
  });

  it("should include soft delete field if present on the model", async () => {
    const migration = await generateMigration(
      UserSoftDelete,
      "create_orders",
      DBType.SQLite,
    );

    expect(migration.up[0]).toContain("deleted_at TEXT");
  });

  it("should generate DROP TABLE for down migration", async () => {
    const migration = await generateMigration(
      User,
      "create_users",
      DBType.SQLite,
    );

    expect(migration.down[0]).toBe("DROP TABLE IF EXISTS users");
  });

  it("should generate migration with correct name", async () => {
    const migration = await generateMigration(
      User,
      "create_users_table",
      DBType.SQLite,
    );

    expect(migration.name).toBe("create_users_table");
  });
});

describe("defineModel", () => {
  it("should store model metadata", () => {
    const meta = MetadataStorage.getModelMetadata(User);
    expect(meta).toBeDefined();
    expect(meta?.tableName).toBe("users");
  });

  it("should return table name", () => {
    const tableName = MetadataStorage.getTableName(User);
    expect(tableName).toBe("users");
  });

  it("should return columns", () => {
    const columns = MetadataStorage.getColumns(User);
    expect(columns).toHaveProperty("id");
    expect(columns).toHaveProperty("user_name");
    expect(columns).toHaveProperty("created_at");
  });

  it("should detect soft delete field", () => {
    const field = MetadataStorage.getSoftDeleteField(UserSoftDelete);
    expect(field).toBe("deleted_at");
  });

  it("should return null for models without soft delete", () => {
    const field = MetadataStorage.getSoftDeleteField(User);
    expect(field).toBeNull();
  });
});
