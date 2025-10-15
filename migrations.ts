import { DBClient } from "./client";
import { ModelKey, ColumnKey, ValidatorKey, SoftDeleteKey } from "./decorators";
import { type DBConfig, type Migration, StabilizeError, DBType } from "./types";

type ColumnData = { name: string; type: string };
type ColumnMetadata = Record<string, ColumnData>;
type ValidatorMetadata = Record<string, string[]>;

// Helper to get SQL type for auto-increment PK
function getAutoIncrementPK(dbType: DBType) {
  switch (dbType) {
    case DBType.Postgres:
      return "SERIAL PRIMARY KEY";
    case DBType.MySQL:
      return "INT AUTO_INCREMENT PRIMARY KEY";
    case DBType.SQLite:
      return "INTEGER PRIMARY KEY AUTOINCREMENT";
    default: // Default to Postgres
      return "SERIAL PRIMARY KEY";
  }
}

// Helper to get SQL type for timestamps
function getTimestampType(dbType: DBType) {
  switch (dbType) {
    case DBType.Postgres:
      return "TIMESTAMP";
    case DBType.MySQL:
      return "DATETIME";
    case DBType.SQLite:
      return "TEXT";
    default: // Default to Postgres
      return "TIMESTAMP";
  }
}

export async function generateMigration(
  model: new (...args: any[]) => any,
  name: string,
  dbType: DBType = DBType.Postgres, // default to Postgres
): Promise<Migration> {
  const tableName = Reflect.getMetadata(ModelKey, model);
  if (!tableName)
    throw new StabilizeError(
      "Model not decorated with @Model",
      "MIGRATION_ERROR",
    );

  const columns: ColumnMetadata =
    Reflect.getMetadata(ColumnKey, model.prototype) || {};
  const validators: ValidatorMetadata =
    Reflect.getMetadata(ValidatorKey, model.prototype) || {};
  const softDeleteField = Reflect.getMetadata(SoftDeleteKey, model.prototype);

  const columnDefs = Object.entries(columns).map(([key, col]) => {
    let def: string;
    if (col.name === "id") {
      // Use correct PK syntax for each DB
      def = getAutoIncrementPK(dbType);
      return def;
    }
    def = `${col.name} ${col.type}`;
    if (validators[key]?.includes("required")) def += " NOT NULL";
    if (validators[key]?.includes("unique")) def += " UNIQUE";
    // Handle timestamps
    if (["createdAt", "updatedAt"].includes(col.name)) {
      def = `${col.name} ${getTimestampType(dbType)}`;
    }
    return def;
  });

  if (softDeleteField && columns[softDeleteField]) {
    columnDefs.push(
      `${columns[softDeleteField].name} ${columns[softDeleteField].type}`,
    );
  }

  const up = [
    `CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs.join(", ")})`,
  ];
  const down = [`DROP TABLE IF EXISTS ${tableName}`];

  return { up, down };
}

// Create migrations table with correct types for each DB
function getMigrationsTableSQL(dbType: DBType) {
  switch (dbType) {
    case DBType.Postgres:
      return `CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP NOT NULL
      )`;
    case DBType.MySQL:
      return `CREATE TABLE IF NOT EXISTS migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at DATETIME NOT NULL
      )`;
    case DBType.SQLite:
      return `CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`;
    default: // Default to Postgres
      return `CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP NOT NULL
      )`;
  }
}

export async function runMigrations(config: DBConfig, migrations: Migration[]) {
  const client = new DBClient(config);
  try {
    // Detect DB type from config
    const dbType = config.type ?? DBType.Postgres;

    await client.query(getMigrationsTableSQL(dbType));

    for (const [index, migration] of migrations.entries()) {
      const name = `migration_${index}_${new Date().toISOString().replace(/[-:T.]/g, "")}`;
      const applied = await client.query<{ id: number }>(
        `SELECT id FROM migrations WHERE name = ?`,
        [name],
      );

      if (applied.length === 0) {
        for (const query of migration.up) {
          await client.query(query, []);
        }
        await client.query(
          `INSERT INTO migrations (name, applied_at) VALUES (?, ?)`,
          [name, new Date().toISOString()],
        );
      }
    }
  } finally {
    await client.close();
  }
}

export type { Migration };