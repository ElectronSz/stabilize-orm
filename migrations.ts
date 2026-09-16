/**
 * @file migrations.ts
 * @description Contains functions for generating and running database migrations based on model metadata.
 * @author ElectronSz
 * @date 2025-10-15 20:55:49
 */

import { DBClient } from "./client";
import { MetadataStorage } from "./model";
import {
  type DBConfig,
  type Migration,
  StabilizeError,
  DBType,
  DataTypes,
} from "./types";
import { runMongoMigrations } from "./mongo-migrate";

/**
 * Quotes an identifier for the target dialect.
 *
 * `"x"` is an identifier only where the dialect's grammar says so. MySQL and
 * MariaDB read it as a *string literal* unless the server runs with
 * `ANSI_QUOTES` in `sql_mode` — off by default — so `CREATE TABLE "users" (…)`
 * is a syntax error there and backticks are the spelling that always parses.
 * Postgres and SQLite quote with `"`, and T-SQL accepts it too under
 * `QUOTED_IDENTIFIER ON`, which is the default, so those three keep it.
 *
 * @param name The bare identifier.
 * @param dbType The target database dialect.
 * @returns The identifier wrapped for the dialect.
 */
export function quoteIdentifier(name: string, dbType: DBType): string {
  return dbType === DBType.MySQL ? `\`${name}\`` : `"${name}"`;
}

/**
 * @internal
 * Recovers the bare name from an identifier quoted for any dialect.
 *
 * SQL Server's catalogue functions take an unquoted name, so the quoting
 * {@link quoteIdentifier} added has to come back off before one is built.
 * Both spellings are stripped rather than just the one the current dialect
 * uses, so a caller passing an already-quoted identifier gets the right answer
 * whichever dialect produced it.
 *
 * @param name The quoted identifier.
 * @returns The bare name.
 */
function unquoteIdentifier(name: string): string {
  return name.replace(/^[`"]/, "").replace(/[`"]$/, "");
}

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
 * Builds a `CREATE TABLE` that is a no-op when the table already exists.
 *
 * SQLite, MySQL and PostgreSQL spell this `CREATE TABLE IF NOT EXISTS`. T-SQL
 * has no such clause and rejects the statement outright, so SQL Server gets the
 * equivalent written as a leading existence check on the same batch instead.
 *
 * @param table The table identifier, already quoted for the dialect if needed.
 * @param body The column definitions, without the surrounding parentheses.
 * @param dbType The target database dialect.
 * @returns The complete statement.
 */
export function createTableIfNotExistsSQL(
  table: string,
  body: string,
  dbType: DBType,
): string {
  if (dbType !== DBType.MSSQL) {
    return `CREATE TABLE IF NOT EXISTS ${table} (${body})`;
  }
  // `OBJECT_ID` takes the bare name, not the quoted identifier, and the `N'…'`
  // prefix keeps it Unicode so a non-ASCII table name still resolves.
  const bare = unquoteIdentifier(table).replace(/'/g, "''");
  return `IF OBJECT_ID(N'${bare}', N'U') IS NULL CREATE TABLE ${table} (${body})`;
}

/**
 * Builds a `CREATE INDEX` that is a no-op when the index already exists.
 *
 * Only Postgres and SQLite support the clause itself. As with
 * {@link createTableIfNotExistsSQL}, SQL Server has no `IF NOT EXISTS` clause
 * to hang on the statement, so the check is a separate one against
 * `sys.indexes` on the same batch. MySQL and MariaDB have neither the clause
 * nor an inline substitute, so for them the caller does the checking — see the
 * `DBType.MySQL` branch below.
 *
 * @param index The index identifier, already quoted for the dialect if needed.
 * @param table The table identifier, already quoted for the dialect if needed.
 * @param columns The indexed column identifiers, already quoted.
 * @param unique Whether the index enforces uniqueness.
 * @param dbType The target database dialect.
 * @returns The complete statement.
 */
export function createIndexIfNotExistsSQL(
  index: string,
  table: string,
  columns: string[],
  unique: boolean,
  dbType: DBType,
): string {
  const kind = unique ? "UNIQUE INDEX" : "INDEX";
  const statement = `CREATE ${kind} ${index} ON ${table} (${columns.join(", ")})`;
  if (dbType === DBType.MySQL) {
    // MySQL and MariaDB have no `IF NOT EXISTS` clause on `CREATE INDEX` — the
    // server rejects it as a syntax error however the identifiers are quoted —
    // so the statement is issued plain, and the guarantee has to come from
    // whoever calls this. `autoMigrate` is the only caller and satisfies it
    // already: it reads the table's indexes from `information_schema` (via
    // `SHOW INDEX`) and skips any name it finds, which is the pre-check, done
    // once for every index rather than once per statement. Nothing else may
    // call this for a MySQL target without doing the same.
    return statement;
  }
  if (dbType !== DBType.MSSQL) {
    return `CREATE ${kind} IF NOT EXISTS ${index} ON ${table} (${columns.join(", ")})`;
  }
  const bareIndex = unquoteIdentifier(index).replace(/'/g, "''");
  const bareTable = unquoteIdentifier(table).replace(/'/g, "''");
  return `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${bareIndex}' AND object_id = OBJECT_ID(N'${bareTable}')) ${statement}`;
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
      case "string":
        return "TEXT";
      case "text":
        return "TEXT";
      case "integer":
        return "INTEGER";
      case "bigint":
        return "BIGINT";
      case "float":
        return "REAL";
      case "double":
        return "DOUBLE PRECISION";
      case "decimal":
        return "DECIMAL";
      case "boolean":
        return "BOOLEAN";
      case "date":
        return "DATE";
      case "datetime":
        return "TIMESTAMP";
      case "json":
        return "JSONB";
      case "uuid":
        return "UUID";
      case "blob":
        return "BYTEA";
      default:
        return "TEXT";
    }
  }
  if (dbType === DBType.MySQL) {
    switch (type) {
      case "string":
        return "VARCHAR(255)";
      case "text":
        return "TEXT";
      case "integer":
        return "INT";
      case "bigint":
        return "BIGINT";
      case "float":
        return "FLOAT";
      case "double":
        return "DOUBLE";
      case "decimal":
        return "DECIMAL(10,2)";
      case "boolean":
        return "TINYINT(1)";
      case "date":
        return "DATE";
      case "datetime":
        return "DATETIME";
      case "json":
        return "JSON";
      case "uuid":
        return "CHAR(36)";
      case "blob":
        return "BLOB";
      default:
        return "TEXT";
    }
  }
  if (dbType === DBType.MSSQL) {
    switch (type) {
      case "string":
        return "NVARCHAR(255)";
      case "text":
        return "NVARCHAR(MAX)";
      case "integer":
        return "INT";
      case "bigint":
        return "BIGINT";
      case "float":
        return "REAL";
      case "double":
        return "FLOAT";
      case "decimal":
        return "DECIMAL(10,2)";
      case "boolean":
        return "BIT";
      case "date":
        return "DATE";
      case "datetime":
        return "DATETIME2";
      case "json":
        return "NVARCHAR(MAX)";
      case "uuid":
        return "UNIQUEIDENTIFIER";
      case "blob":
        return "VARBINARY(MAX)";
      default:
        return "NVARCHAR(MAX)";
    }
  }
  if (dbType === DBType.SQLite) {
    switch (type) {
      case "string":
        return "TEXT";
      case "text":
        return "TEXT";
      case "integer":
        return "INTEGER";
      case "bigint":
        return "INTEGER";
      case "float":
        return "REAL";
      case "double":
        return "REAL";
      case "decimal":
        return "NUMERIC";
      case "boolean":
        return "INTEGER";
      case "date":
        return "TEXT";
      case "datetime":
        return "TEXT";
      case "json":
        return "TEXT";
      case "uuid":
        return "TEXT";
      case "blob":
        return "BLOB";
      default:
        return "TEXT";
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
    case DBType.MSSQL:
      return "INT IDENTITY(1,1) PRIMARY KEY";
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
    throw new StabilizeError(
      "Model not defined with tableName",
      "MIGRATION_ERROR",
    );
  }

  const columns = MetadataStorage.getColumns(model);
  const validators = MetadataStorage.getValidators(model);
  const versioned = MetadataStorage.isVersioned(model);
  const timestamps = MetadataStorage.getTimestamps(model);

  const columnDefs: string[] = [];

  for (const [key, col] of Object.entries(columns)) {
    const defParts: string[] = [];

    if (key === "id") {
      defParts.push("id");
      // `type` is typed as the DataTypes enum but may arrive as a literal
      // string when the model came from another copy of the ORM.
      const idTypeRaw: any = col.type;
      const idTypeStr =
        typeof idTypeRaw === "string"
          ? idTypeRaw.toLowerCase()
          : (DataTypes as any)[idTypeRaw]?.toLowerCase();
      if (idTypeStr === "string" || idTypeStr === "uuid") {
        defParts.push(
          dbType === DBType.Postgres
            ? "UUID PRIMARY KEY"
            : dbType === DBType.MySQL
              ? "VARCHAR(255) PRIMARY KEY"
              : dbType === DBType.MSSQL
                ? idTypeStr === "uuid"
                  ? "UNIQUEIDENTIFIER PRIMARY KEY"
                  : "NVARCHAR(255) PRIMARY KEY"
                : "TEXT PRIMARY KEY",
        );
      } else {
        defParts.push(getAutoIncrementPK(dbType));
      }
    } else {
      defParts.push(col.name || key);
      defParts.push(mapDataTypeToSql(col.type, dbType));

      if (validators[key]?.includes("required")) {
        defParts.push("NOT NULL");
      }
      if (validators[key]?.includes("unique")) {
        defParts.push("UNIQUE");
      }
      if (col.defaultValue !== undefined) {
        defParts.push(`DEFAULT ${JSON.stringify(col.defaultValue)}`);
      } else if (col.defaultExpression) {
        defParts.push(`DEFAULT ${col.defaultExpression.sql}`);
      }
      if (col.index) {
        defParts.push(`INDEX ${col.index}`);
      }
    }

    columnDefs.push(defParts.join(" "));
  }

  // Add timestamp columns if enabled. A model may declare them in `columns`
  // as well as in `timestamps` — the documented pattern — so skip any column
  // that is already in the table definition rather than emitting it twice
  // (which makes the CREATE TABLE fail with "duplicate column name").
  if (timestamps) {
    const declared = new Set(
      Object.entries(columns).map(([key, col]) => col.name || key),
    );
    for (const [field, colName] of Object.entries(timestamps)) {
      if (!colName || declared.has(colName)) continue;
      // Use the field name defined in the timestamps config
      let sqlType =
        dbType === DBType.Postgres
          ? "TIMESTAMP"
          : dbType === DBType.MSSQL
            ? "DATETIME2"
            : "DATETIME";
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

  const up: string[] = [
    createTableIfNotExistsSQL(tableName, columnDefs.join(", "), dbType),
  ];
  const down: string[] = [`DROP TABLE IF EXISTS ${tableName}`];

  if (versioned) {
    const [historyUp, historyDown] = generateHistoryMigration(
      tableName,
      columnDefs,
      dbType,
    );
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
  let tsType =
    dbType === DBType.MySQL
      ? "DATETIME"
      : dbType === DBType.MSSQL
        ? "DATETIME2"
        : dbType === DBType.SQLite
          ? "TEXT"
          : "TIMESTAMP";
  let modByType =
    dbType === DBType.MySQL
      ? "VARCHAR(255)"
      : dbType === DBType.MSSQL
        ? "NVARCHAR(255)"
        : "TEXT";
  let modAtType =
    tsType + (dbType === DBType.Postgres ? " DEFAULT CURRENT_TIMESTAMP" : "");

  // Strip constraints for history columns
  function cleanColumnDef(def: string): string {
    return def.replace(/\s+PRIMARY\s+KEY\b/gi, "").replace(/\s+UNIQUE\b/gi, "");
  }

  const historyColumns = [
    ...columnDefs.map(cleanColumnDef),
    `operation ${opType}`,
    `version ${versionType}`,
    `valid_from ${tsType} NOT NULL`,
    `valid_to ${tsType}`,
    `modified_by ${modByType}`,
    `modified_at ${modAtType}`,
  ];
  return [
    createTableIfNotExistsSQL(historyTable, historyColumns.join(", "), dbType),
    `DROP TABLE IF EXISTS ${historyTable}`,
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
    case DBType.MSSQL:
      return createTableIfNotExistsSQL(
        "stabilize_migrations",
        `id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(255) UNIQUE NOT NULL,
        applied_at DATETIME2 NOT NULL DEFAULT CURRENT_TIMESTAMP`,
        DBType.MSSQL,
      );
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
  // Branched before `getMigrationsTableSQL` can be asked about a dialect it has
  // no answer for: there is no `CREATE TABLE` here, and a migration's Mongo
  // half rides in `mongoUp`/`mongoDown` rather than in `up`/`down`.
  if (config.type === DBType.MongoDB) {
    return runMongoMigrations(config, migrations);
  }

  const client = new DBClient(config);
  try {
    const dbType = config.type;
    await client.query(getMigrationsTableSQL(dbType));

    for (const [index, migration] of migrations.entries()) {
      const name =
        migration.name || `migration_${index}_${new Date().getTime()}`;

      const selectQuery = formatQuery(
        `SELECT id FROM stabilize_migrations WHERE name = ?`,
        dbType,
      );
      const applied = await client.query<{ id: number }>(selectQuery, [name]);

      if (applied.length === 0) {
        await client.transaction(async (txClient) => {
          console.log(`Applying migration: ${name}...`);
          for (const query of migration.up) {
            await txClient.query(query);
          }

          const insertQuery = formatQuery(
            `INSERT INTO stabilize_migrations (name, applied_at) VALUES (?, ?)`,
            dbType,
          );
          let appliedAt: string;
          if (dbType === DBType.MySQL) {
            appliedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
          } else if (dbType === DBType.MSSQL) {
            // The trailing `Z` an ISO string carries is only meaningful for
            // `datetimeoffset`; `datetime2` wants a space separator and no
            // zone designator, which every server language parses the same way.
            appliedAt = new Date().toISOString().slice(0, 23).replace("T", " ");
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
