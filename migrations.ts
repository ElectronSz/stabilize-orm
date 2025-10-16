/**
 * @file migrations.ts
 * @description Contains functions for generating and running database migrations based on model metadata.
 * @author ElectronSz
 * @date 2025-10-15 20:55:49
 */

import { DBClient } from "./client";
import { ModelKey, ColumnKey, ValidatorKey, SoftDeleteKey } from "./decorators";
import { type DBConfig, type Migration, StabilizeError, DBType, DataTypes } from "./types";

type ColumnData = { name: string; type: string };
type ColumnMetadata = Record<string, ColumnData>;
type ValidatorMetadata = Record<string, string[]>;

// --- FIX: New Helper Function to format queries for different DBs ---
/**
 * @internal
 * Formats a SQL query with placeholders for the target database dialect.
 * Replaces '?' with '$1', '$2', etc. for PostgreSQL.
 * @param query The SQL query string with '?' placeholders.
 * @param dbType The target database dialect.
 * @returns The formatted SQL query string.
 */
function formatQuery(query: string, dbType: DBType): string {
  if (dbType === DBType.Postgres) {
    let paramIndex = 1;
    return query.replace(/\?/g, () => `$${paramIndex++}`);
  }
  return query;
}


/**
 * Maps an abstract data type (from DataTypes enum or a string) to the correct SQL type string
 * for the specified database dialect (Postgres, MySQL, or SQLite).
 *
 * This function enables model definitions to be portable across different databases by
 * converting each logical type to its proper SQL type in CREATE TABLE migrations.
 *
 * @param dt - The data type to map. Accepts either a value from the DataTypes enum, or a string
 *             (e.g., "string", "integer", "boolean", etc.).
 * @param dbType - The target database dialect (DBType.Postgres, DBType.MySQL, or DBType.SQLite).
 * @returns The SQL column type string appropriate for the database and logical type.
 *
 */
function mapDataTypeToSql(dt: DataTypes | string, dbType: DBType): string {
  let type: string;
  if (typeof dt === "string") {
    type = dt.toLowerCase();
  } else {
    type = DataTypes[dt].toLowerCase();
  }

  if (dbType === DBType.Postgres) {
    switch (type) {
      case "string": return "TEXT";
      case "text": return "TEXT";
      case "integer": return "INTEGER";
      case "bigint": return "BIGINT";
      case "float": return "REAL";
      case "double": return "DOUBLE PRECISION";
      case "decimal": return "DECIMAL";
      case "boolean": return "BOOLEAN";
      case "date": return "DATE";
      case "datetime": return "TIMESTAMP";
      case "json": return "JSONB";
      case "uuid": return "UUID";
      case "blob": return "BYTEA";
      default: return "TEXT";
    }
  }
  if (dbType === DBType.MySQL) {
    switch (type) {
      case "string": return "VARCHAR(255)";
      case "text": return "TEXT";
      case "integer": return "INT";
      case "bigint": return "BIGINT";
      case "float": return "FLOAT";
      case "double": return "DOUBLE";
      case "decimal": return "DECIMAL(10,2)";
      case "boolean": return "TINYINT(1)";
      case "date": return "DATE";
      case "datetime": return "DATETIME";
      case "json": return "JSON";
      case "uuid": return "CHAR(36)";
      case "blob": return "BLOB";
      default: return "TEXT";
    }
  }
  // SQLite
  if (dbType === DBType.SQLite) {
    switch (type) {
      case "string": return "TEXT";
      case "text": return "TEXT";
      case "integer": return "INTEGER";
      case "bigint": return "INTEGER";
      case "float": return "REAL";
      case "double": return "REAL";
      case "decimal": return "NUMERIC";
      case "boolean": return "INTEGER";
      case "date": return "TEXT";
      case "datetime": return "TEXT";
      case "json": return "TEXT";
      case "uuid": return "TEXT";
      case "blob": return "BLOB";
      default: return "TEXT";
    }
  }
  return "TEXT";
}


/**
 * @internal
 * Gets the database-specific SQL for an auto-incrementing primary key.
 * @param dbType The target database dialect.
 * @returns The SQL string for the primary key column definition.
 */
function getAutoIncrementPK(dbType: DBType): string {
  switch (dbType) {
    case DBType.Postgres:
      return "SERIAL PRIMARY KEY";
    case DBType.MySQL:
      return "INT AUTO_INCREMENT PRIMARY KEY";
    case DBType.SQLite:
    default:
      return "INTEGER PRIMARY KEY AUTOINCREMENT";
  }
}

/**
 * @internal
 * Gets the database-specific SQL for a timestamp column.
 * @param dbType The target database dialect.
 * @returns The SQL string for the timestamp column type.
 */
function getTimestampType(dbType: DBType): string {
  switch (dbType) {
    case DBType.Postgres:
      return "TIMESTAMP";
    case DBType.MySQL:
      return "DATETIME";
    case DBType.SQLite:
    default:
      return "TEXT";
  }
}

/**
 * @internal
 * Gets the database-specific SQL for a default `CURRENT_TIMESTAMP` value.
 * @param dbType The target database dialect.
 * @returns The SQL string for the default value.
 */
function getTimestampDefault(dbType: DBType): string {
  switch (dbType) {
    case DBType.Postgres:
    case DBType.SQLite:
      return "DEFAULT CURRENT_TIMESTAMP";
    case DBType.MySQL:
      return "DEFAULT CURRENT_TIMESTAMP";
    default:
      return "DEFAULT CURRENT_TIMESTAMP";
  }
}

/**
 * Generates SQL migration scripts (`up` and `down`) based on a model's decorators.
 * This function reads the metadata from a model class to create a `CREATE TABLE` statement.
 *
 * @param model The model class decorated with `@Model` and `@Column`.
 * @param name A descriptive name for the migration (used for the migration object).
 * @param dbType The target database dialect to generate SQL for. Defaults to Postgres.
 * @returns A promise that resolves to a `Migration` object containing the `up` and `down` SQL scripts.
 */
export async function generateMigration(
  model: new (...args: any[]) => any,
  name: string,
  dbType: DBType,
): Promise<Migration> {
  const tableName = Reflect.getMetadata(ModelKey, model);
  if (!tableName) {
    throw new StabilizeError("Model not decorated with @Model", "MIGRATION_ERROR");
  }

  const columns: ColumnMetadata = Reflect.getMetadata(ColumnKey, model.prototype) || {};
  const validators: ValidatorMetadata = Reflect.getMetadata(ValidatorKey, model.prototype) || {};

  const columnDefs: string[] = [];

  for (const [key, col] of Object.entries(columns)) {
    const defParts: string[] = [];

    if (col.name === "id") {
      defParts.push("id");
      defParts.push(getAutoIncrementPK(dbType));
    } else {
      defParts.push(col.name);
      defParts.push(mapDataTypeToSql(col.type, dbType));
    }

    if (validators[key]?.includes("required")) {
      defParts.push("NOT NULL");
    }
    if (validators[key]?.includes("unique")) {
      defParts.push("UNIQUE");
    }

    columnDefs.push(defParts.join(" "));
  }

  const up = [`CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs.join(", ")})`];
  const down = [`DROP TABLE IF EXISTS ${tableName}`];

  return { up, down, name };
}

/**
 * @internal
 * Gets the database-specific SQL for creating the `migrations` table, which tracks applied migrations.
 * @param dbType The target database dialect.
 * @returns The SQL string for the `CREATE TABLE` statement.
 */
function getMigrationsTableSQL(dbType: DBType): string {
  switch (dbType) {
    case DBType.Postgres:
      return `CREATE TABLE IF NOT EXISTS stabilize_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
    case DBType.MySQL:
      return `CREATE TABLE IF NOT EXISTS stabilize_migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
    case DBType.SQLite:
    default:
      return `CREATE TABLE IF NOT EXISTS stabilize_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
  }
}

/**
 * Connects to the database and runs all pending migrations.
 * It tracks which migrations have been applied by using a `migrations` table in the database.
 * Each migration is run within a transaction to ensure atomicity.
 *
 * @param config The database configuration object.
 * @param migrations An array of `Migration` objects to be executed.
 */
export async function runMigrations(config: DBConfig, migrations: Migration[]) {
  const client = new DBClient(config);
  try {
    const dbType = config.type;
    await client.query(getMigrationsTableSQL(dbType));

    for (const [index, migration] of migrations.entries()) {
      const name = migration.name || `migration_${index}_${new Date().getTime()}`;

      const selectQuery = formatQuery(`SELECT id FROM stabilize_migrations WHERE name = ?`, dbType);
      const applied = await client.query<{ id: number }>(selectQuery, [name]);

      if (applied.length === 0) {
        await client.transaction(async (txClient) => {
          console.log(`Applying migration: ${name}...`);
          for (const query of migration.up) {
            await txClient.query(query);
          }

          const insertQuery = formatQuery(`INSERT INTO stabilize_migrations (name, applied_at) VALUES (?, ?)`, dbType);
          await txClient.query(insertQuery, [name, new Date().toISOString()]);

          console.log(`Migration ${name} applied successfully.`);
        });
      }
    }
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  } finally {
    await client.close();
  }
}

export type { Migration };