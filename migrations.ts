/**
 * @file migrations.ts
 * @description Contains functions for generating and running database migrations based on model metadata.
 * @author ElectronSz
 */

import { DBClient } from "./client";
import { ModelKey, ColumnKey, ValidatorKey, SoftDeleteKey } from "./decorators";
import { type DBConfig, type Migration, StabilizeError, DBType } from "./types";

type ColumnData = { name: string; type: string };
type ColumnMetadata = Record<string, ColumnData>;
type ValidatorMetadata = Record<string, string[]>;

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
 * @example
 * ```
 * // In a script like 'scripts/generate_user_migration.ts'
 * import { generateMigration, DBType } from 'stabilize-orm';
 * import { User } from './models/user';
 * import fs from 'fs';
 *
 * async function createMigration() {
 *   const migration = await generateMigration(User, 'create_users_table', DBType.Postgres);
 *   fs.writeFileSync(
 *     `migrations/${new Date().getTime()}_create_users.json`,
 *     JSON.stringify(migration, null, 2)
 *   );
 * }
 *
 * createMigration();
 * ```
 */
export async function generateMigration(
  model: new (...args: any[]) => any,
  name: string, 
  dbType: DBType = DBType.Postgres,
): Promise<Migration> {
  const tableName = Reflect.getMetadata(ModelKey, model);
  if (!tableName) {
    throw new StabilizeError("Model not decorated with @Model", "MIGRATION_ERROR");
  }

  const columns: ColumnMetadata = Reflect.getMetadata(ColumnKey, model.prototype) || {};
  const validators: ValidatorMetadata = Reflect.getMetadata(ValidatorKey, model.prototype) || {};
  const softDeleteField = Reflect.getMetadata(SoftDeleteKey, model.prototype);

  const columnDefs = Object.entries(columns).map(([key, col]) => {
    if (col.name === "id") {
      return `id ${getAutoIncrementPK(dbType)}`;
    }

    const defParts: string[] = [col.name];
    
    if (["createdAt", "updatedAt"].includes(key) || (softDeleteField && key === softDeleteField)) {
      defParts.push(getTimestampType(dbType));
    } else {
      defParts.push(col.type);
    }

    if (validators[key]?.includes("required")) {
      defParts.push("NOT NULL");
    }
    if (validators[key]?.includes("unique")) {
      defParts.push("UNIQUE");
    }

    if (key === "createdAt") {
      defParts.push(getTimestampDefault(dbType));
    }

    return defParts.join(" ");
  });

  if (softDeleteField && !columns[softDeleteField]) {
    columnDefs.push(`${softDeleteField} ${getTimestampType(dbType)}`);
  }

  const up = [`CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs.join(", ")})`];
  const down = [`DROP TABLE IF EXISTS ${tableName}`];

  return { up, down, name: tableName }; 
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
      return `CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
    case DBType.MySQL:
      return `CREATE TABLE IF NOT EXISTS migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
    case DBType.SQLite:
    default:
      return `CREATE TABLE IF NOT EXISTS migrations (
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
 * @example
 * ```
 * // In a script like 'scripts/run_all_migrations.ts'
 * import { runMigrations } from 'stabilize-orm';
 * import { dbConfig } from './config';
 * import migration1 from '../migrations/1_create_users.json';
 * import migration2 from '../migrations.ts/2_create_profiles.json';
 *
 * const allMigrations = [migration1, migration2];
 *
 * async function applyMigrations() {
 *   console.log('Starting migration process...');
 *   await runMigrations(dbConfig, allMigrations);
 *   console.log('All pending migrations applied successfully.');
 * }
 *
 * applyMigrations();
 * ```
 */
export async function runMigrations(config: DBConfig, migrations: Migration[]) {
  const client = new DBClient(config);
  try {
    const dbType = config.type;
    await client.query(getMigrationsTableSQL(dbType));

    for (const [index, migration] of migrations.entries()) {
      const name = migration.name || `migration_${index}_${new Date().getTime()}`;
      
      const applied = await client.query<{ id: number }>(
        `SELECT id FROM migrations WHERE name = ?`,
        [name],
      );

      if (applied.length === 0) {
        await client.transaction(async (txClient) => {
          console.log(`Applying migration: ${name}...`);
          for (const query of migration.up) {
            await txClient.query(query);
          }
          await txClient.query(
            `INSERT INTO migrations (name, applied_at) VALUES (?, ?)`,
            [name, new Date().toISOString()],
          );
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