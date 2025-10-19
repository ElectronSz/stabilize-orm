/**
 * @file migrations.ts
 * @description Contains functions for generating and running database migrations based on model metadata.
 * @author ElectronSz
 * @date 2025-10-15 20:55:49
 */

import { DBClient } from "./client";
import { MetadataStorage } from "./model";
import { type DBConfig, type Migration, StabilizeError, DBType, DataTypes } from "./types";

/**
 * @internal
 * Formats a SQL query with placeholders for the target database dialect.
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
 * Maps an abstract data type to the correct SQL type string for the specified database dialect.
 * @param dt The data type to map.
 * @param dbType The target database dialect.
 * @returns The SQL column type string.
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
 * Generates SQL migration scripts (`up` and `down`) based on a model's configuration.
 * @param model The model class defined with `defineModel`.
 * @param name A descriptive name for the migration.
 * @param dbType The target database dialect.
 * @returns A promise that resolves to a `Migration` object containing the `up` and `down` SQL scripts.
 */
export async function generateMigration(
  model: new (...args: any[]) => any,
  name: string,
  dbType: DBType,
): Promise<Migration> {
  const tableName = MetadataStorage.getTableName(model);
  if (!tableName) {
    throw new StabilizeError("Model not defined with tableName", "MIGRATION_ERROR");
  }

  const columns = MetadataStorage.getColumns(model);
  const validators = MetadataStorage.getValidators(model);
  const versioned = MetadataStorage.isVersioned(model);
  const timestamps = MetadataStorage.getTimestamps(model);

  const columnDefs: string[] = [];

  for (const [key, col] of Object.entries(columns)) {
    const defParts: string[] = [];

    if (col.name === "id") {
      defParts.push("id");
      defParts.push(getAutoIncrementPK(dbType));
    } else {
      defParts.push(col.name || key);
      defParts.push(mapDataTypeToSql(col.type, dbType));
    }

    if (validators[key]?.includes("required")) {
      defParts.push("NOT NULL");
    }
    if (validators[key]?.includes("unique")) {
      defParts.push("UNIQUE");
    }
    if (col.defaultValue !== undefined) {
      defParts.push(`DEFAULT ${JSON.stringify(col.defaultValue)}`);
    }
    if (col.index) {
      defParts.push(`INDEX ${col.index}`);
    }

    columnDefs.push(defParts.join(" "));
  }

  // Add timestamp columns if enabled
  if (timestamps) {
    for (const [field, colName] of Object.entries(timestamps)) {
      // Use the field name defined in the timestamps config
      let sqlType = dbType === DBType.Postgres ? "TIMESTAMP" : "DATETIME";
      let def = `${colName} ${sqlType} NOT NULL`;

      // Set default value for createdAt, and optionally for updatedAt
      if (field === "createdAt") {
        def += " DEFAULT CURRENT_TIMESTAMP";
      } else if (field === "updatedAt") {
        def += " DEFAULT CURRENT_TIMESTAMP";
        // For MySQL, add ON UPDATE CURRENT_TIMESTAMP
        if (dbType === DBType.MySQL) {
          def += " ON UPDATE CURRENT_TIMESTAMP";
        }
      }

      columnDefs.push(def);
    }
  }

  const up: string[] = [`CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs.join(", ")})`];
  const down: string[] = [`DROP TABLE IF EXISTS ${tableName}`];

  if (versioned) {
    const [historyUp, historyDown] = generateHistoryMigration(tableName, columnDefs, dbType);
    up.push(historyUp);
    down.push(historyDown);
  }

  return { up, down, name };
}

/**
 * Generates SQL for a version/audit history table for time-travel queries.
 * @param tableName The name of the main table.
 * @param columnDefs The column definitions (from the main table).
 * @param dbType The target database dialect.
 */
function generateHistoryMigration(
  tableName: string,
  columnDefs: string[],
  dbType: DBType,
): [string, string] {
  const historyTable = `${tableName}_history`;
  let opType = "VARCHAR(10) NOT NULL";
  let versionType = "INT NOT NULL";
  let tsType = dbType === DBType.MySQL ? "DATETIME" :
    dbType === DBType.SQLite ? "TEXT" : "TIMESTAMP";
  let modByType = dbType === DBType.MySQL ? "VARCHAR(255)" : "TEXT";
  let modAtType = tsType + (dbType === DBType.Postgres ? " DEFAULT CURRENT_TIMESTAMP" : "");

  // Strip constraints for history columns
  function cleanColumnDef(def: string): string {
    return def
      .replace(/\s+PRIMARY\s+KEY\b/gi, "")
      .replace(/\s+UNIQUE\b/gi, "");
  }

  const historyColumns = [
    ...columnDefs.map(cleanColumnDef),
    `operation ${opType}`,
    `version ${versionType}`,
    `valid_from ${tsType} NOT NULL`,
    `valid_to ${tsType}`,
    `modified_by ${modByType}`,
    `modified_at ${modAtType}`
  ];
  return [
    `CREATE TABLE IF NOT EXISTS ${historyTable} (${historyColumns.join(", ")})`,
    `DROP TABLE IF EXISTS ${historyTable}`
  ];
}

/**
 * @internal
 * Gets the database-specific SQL for creating the `migrations` table.
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
          let appliedAt: string;
          if (dbType === DBType.MySQL) {
            appliedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
          } else {
            appliedAt = new Date().toISOString();
          }
          await txClient.query(insertQuery, [name, appliedAt]);

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
export { mapDataTypeToSql };
