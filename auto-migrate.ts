/**
 * @file auto-migrate.ts
 * @description GORM-like AutoMigrate: creates tables, adds missing columns, adds missing indexes.
 * NEVER deletes columns or changes types - only adds.
 */

import { DBClient } from "./client";
import { DBType, DataTypes, StabilizeError } from "./types";
import { MetadataStorage } from "./model";
import {
  createIndexIfNotExistsSQL,
  createTableIfNotExistsSQL,
  quoteIdentifier,
} from "./migrations";

async function tableExists(db: DBClient, table: string): Promise<boolean> {
  switch (db.config.type) {
    case DBType.SQLite: {
      const rows = await db.query<any>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = '${table}'`,
      );
      return rows.length > 0;
    }
    case DBType.MySQL: {
      const rows = await db.query<any>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
        [table],
      );
      return rows.length > 0;
    }
    case DBType.Postgres: {
      const rows = await db.query<any>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      return rows.length > 0;
    }
    case DBType.MSSQL: {
      const rows = await db.query<any>(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?`,
        [table],
      );
      return rows.length > 0;
    }
    default:
      return false;
  }
}

async function getExistingColumns(
  db: DBClient,
  table: string,
): Promise<Map<string, string>> {
  const cols = new Map<string, string>();
  switch (db.config.type) {
    case DBType.SQLite: {
      const rows = await db.query<any>(`PRAGMA table_info(${table})`);
      for (const r of rows) cols.set(r.name, r.type);
      break;
    }
    case DBType.MySQL: {
      const rows = await db.query<any>(`SHOW COLUMNS FROM \`${table}\``);
      for (const r of rows) cols.set(r.Field, r.Type);
      break;
    }
    case DBType.Postgres: {
      const rows = await db.query<any>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      for (const r of rows) cols.set(r.column_name, r.data_type);
      break;
    }
    case DBType.MSSQL: {
      // Aliased to the names the rest of this function reads, so the SQLite and
      // MySQL shapes above stay untouched.
      const rows = await db.query<any>(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type,
                IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`,
        [table],
      );
      for (const r of rows) cols.set(r.name, r.type);
      break;
    }
  }
  return cols;
}

async function getExistingIndexes(
  db: DBClient,
  table: string,
): Promise<Map<string, { columns: string[]; unique: boolean }>> {
  const indexes = new Map<string, { columns: string[]; unique: boolean }>();
  switch (db.config.type) {
    case DBType.SQLite: {
      const rows = await db.query<any>(`PRAGMA index_list(${table})`);
      for (const row of rows) {
        const info = await db.query<any>(`PRAGMA index_info('${row.name}')`);
        indexes.set(row.name, {
          columns: info.map((i: any) => i.name),
          unique: !!row.unique,
        });
      }
      break;
    }
    case DBType.MySQL: {
      const rows = await db.query<any>(`SHOW INDEX FROM \`${table}\``);
      for (const row of rows) {
        if (row.Key_name === "PRIMARY") continue;
        if (!indexes.has(row.Key_name)) {
          indexes.set(row.Key_name, { columns: [], unique: !row.Non_unique });
        }
        indexes.get(row.Key_name)!.columns.push(row.Column_name);
      }
      break;
    }
    case DBType.Postgres: {
      const rows = await db.query<any>(
        `SELECT i.relname as index_name, ix.indisunique, a.attname as column_name
         FROM pg_class t
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE t.relname = $1 AND NOT ix.indisprimary
         ORDER BY i.relname, a.attnum`,
        [table],
      );
      for (const row of rows) {
        if (!indexes.has(row.index_name)) {
          indexes.set(row.index_name, { columns: [], unique: row.indisunique });
        }
        indexes.get(row.index_name)!.columns.push(row.column_name);
      }
      break;
    }
    case DBType.MSSQL: {
      // `sys.index_columns` carries one row per indexed column, so walking it
      // in `index_column_id` order rebuilds each index's column list. The
      // primary key is excluded, matching the PostgreSQL query above.
      const rows = await db.query<any>(
        `SELECT i.name AS index_name, i.is_unique AS is_unique, c.name AS column_name
         FROM sys.indexes i
         JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
         JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
         WHERE i.object_id = OBJECT_ID(?) AND i.is_primary_key = 0 AND i.name IS NOT NULL
         ORDER BY i.name, ic.index_column_id`,
        [table],
      );
      for (const row of rows) {
        if (!indexes.has(row.index_name)) {
          indexes.set(row.index_name, {
            columns: [],
            unique: !!row.is_unique,
          });
        }
        indexes.get(row.index_name)!.columns.push(row.column_name);
      }
      break;
    }
  }
  return indexes;
}

function mapType(
  dataType: string,
  dialect: "sqlite" | "mysql" | "postgres" | "mssql",
): string {
  const t = dataType.toUpperCase();
  const map: Record<string, Record<string, string>> = {
    sqlite: {
      STRING: "TEXT",
      TEXT: "TEXT",
      INTEGER: "INTEGER",
      BIGINT: "INTEGER",
      FLOAT: "REAL",
      DOUBLE: "REAL",
      DECIMAL: "NUMERIC",
      BOOLEAN: "INTEGER",
      DATE: "TEXT",
      DATETIME: "TEXT",
      JSON: "TEXT",
      UUID: "TEXT",
      BLOB: "BLOB",
    },
    mysql: {
      STRING: "VARCHAR(255)",
      TEXT: "TEXT",
      INTEGER: "INT",
      BIGINT: "BIGINT",
      FLOAT: "FLOAT",
      DOUBLE: "DOUBLE",
      DECIMAL: "DECIMAL(10,2)",
      BOOLEAN: "TINYINT(1)",
      DATE: "DATE",
      DATETIME: "DATETIME",
      JSON: "JSON",
      UUID: "CHAR(36)",
      BLOB: "BLOB",
    },
    postgres: {
      STRING: "TEXT",
      TEXT: "TEXT",
      INTEGER: "INTEGER",
      BIGINT: "BIGINT",
      FLOAT: "REAL",
      DOUBLE: "DOUBLE PRECISION",
      DECIMAL: "DECIMAL(10,2)",
      BOOLEAN: "BOOLEAN",
      DATE: "DATE",
      DATETIME: "TIMESTAMP",
      JSON: "JSONB",
      UUID: "UUID",
      BLOB: "BYTEA",
    },
    mssql: {
      STRING: "NVARCHAR(255)",
      TEXT: "NVARCHAR(MAX)",
      INTEGER: "INT",
      BIGINT: "BIGINT",
      FLOAT: "REAL",
      DOUBLE: "FLOAT",
      DECIMAL: "DECIMAL(10,2)",
      BOOLEAN: "BIT",
      DATE: "DATE",
      DATETIME: "DATETIME2",
      JSON: "NVARCHAR(MAX)",
      UUID: "UNIQUEIDENTIFIER",
      BLOB: "VARBINARY(MAX)",
    },
  };
  // The fallback is a text column, and T-SQL's `TEXT` is both deprecated and
  // unusable in most expressions, so SQL Server falls back to `NVARCHAR(MAX)`.
  return map[dialect]?.[t] || (dialect === "mssql" ? "NVARCHAR(MAX)" : "TEXT");
}

/**
 * The dialect's unbounded text type, used for the generated timestamp and
 * history columns that `createTableFromMeta` and the history table add.
 */
function textType(dialect: "sqlite" | "mysql" | "postgres" | "mssql"): string {
  return dialect === "mssql" ? "NVARCHAR(255)" : "TEXT";
}

/**
 * Resolves a column's declared type to its name. `type` is either a
 * `DataTypes` enum member (the documented form) or a raw string.
 */
function resolveTypeName(type: any): string {
  return typeof type === "string" ? type : (DataTypes[type] ?? "TEXT");
}

/** Whether a resolved type name is an integer, and so can auto-increment. */
function isIntegerType(typeName: string): boolean {
  return typeName.toUpperCase() === "INTEGER" || typeName.toUpperCase() === "BIGINT";
}

function getAutoIncrementPK(
  dialect: "sqlite" | "mysql" | "postgres" | "mssql",
): string {
  switch (dialect) {
    case "mysql":
      return "INT AUTO_INCREMENT PRIMARY KEY";
    case "postgres":
      return "SERIAL PRIMARY KEY";
    case "mssql":
      return "INT IDENTITY(1,1) PRIMARY KEY";
    default:
      return "INTEGER PRIMARY KEY AUTOINCREMENT";
  }
}

/**
 * GORM-style AutoMigrate.
 *
 * - Creates table if it doesn't exist
 * - Adds missing columns (never deletes or changes type)
 * - Creates missing indexes
 * - Creates history table if model is versioned
 *
 * Usage:
 * ```
 * await orm.autoMigrate([User, Post, Comment]);
 * ```
 */
export async function autoMigrate(
  db: DBClient,
  models: any | any[],
): Promise<void> {
  const list = Array.isArray(models) ? models : [models];
  // Every identifier this file emits goes through `quoteIdentifier`, so the
  // DDL parses on MySQL-family servers (backticks) as well as the rest (`"`).
  // @see quoteIdentifier for why the two spellings are not interchangeable.
  const q = (name: string) => quoteIdentifier(name, db.config.type);
  const dialect =
    db.config.type === DBType.SQLite
      ? "sqlite"
      : db.config.type === DBType.MySQL
        ? "mysql"
        : db.config.type === DBType.MSSQL
          ? "mssql"
          : "postgres";

  for (const model of list) {
    // Try MetadataStorage first (defineModel), fall back to model.schema
    const meta = MetadataStorage.getModelMetadata(model);
    const tableName = meta?.tableName || model.schema?.tableName;

    if (!tableName) {
      throw new StabilizeError(
        `Model is missing tableName. Use defineModel() or add static schema.`,
        "MIGRATE_ERROR",
      );
    }

    const exists = await tableExists(db, tableName);

    if (!exists) {
      // Create table from defineModel metadata
      if (meta) {
        await createTableFromMeta(db, meta, tableName, dialect);
      } else {
        // Legacy schema format
        await createTableFromSchema(db, model.schema, tableName, dialect);
      }
    } else {
      // Add missing columns
      const existingCols = await getExistingColumns(db, tableName);
      if (meta) {
        for (const [key, col] of Object.entries(meta.columns)) {
          const colName = (col as any).name || key;
          if (!existingCols.has(colName)) {
            const sqlType = mapType(
              typeof (col as any).type === "string"
                ? (col as any).type
                : DataTypes[(col as any).type],
              dialect,
            );
            const notNull = (col as any).required ? " NOT NULL" : "";
            const defaultVal =
              (col as any).defaultValue !== undefined
                ? ` DEFAULT ${JSON.stringify((col as any).defaultValue)}`
                : "";
            const unique = (col as any).unique ? " UNIQUE" : "";
            // `ADD COLUMN` is the spelling SQLite, MySQL and PostgreSQL share;
            // T-SQL's grammar is `ADD <definition>`, with no `COLUMN` keyword.
            const addColumn =
              db.config.type === DBType.MSSQL ? "ADD" : "ADD COLUMN";
            await db.migrationQuery(
              `ALTER TABLE ${q(tableName)} ${addColumn} ${q(colName)} ${sqlType}${notNull}${defaultVal}${unique}`,
            );
          }
        }
      }
    }

    // Create indexes. This read is what makes the statements below idempotent
    // on MySQL and MariaDB, which have no `IF NOT EXISTS` clause to put on a
    // `CREATE INDEX` and so cannot enforce it themselves — the name check here
    // is the whole of the guarantee. @see createIndexIfNotExistsSQL.
    const existingIndexes = await getExistingIndexes(db, tableName);
    if (meta) {
      for (const [key, col] of Object.entries(meta.columns)) {
        const colName = (col as any).name || key;
        if ((col as any).unique && key !== "id") {
          const idxName = `${tableName}_${colName}_uniq`;
          if (!existingIndexes.has(idxName)) {
            await db.migrationQuery(
              createIndexIfNotExistsSQL(
                q(idxName),
                q(tableName),
                [q(colName)],
                true,
                db.config.type,
              ),
            );
          }
        }
        if ((col as any).index && typeof (col as any).index === "string") {
          const idxName = (col as any).index;
          if (!existingIndexes.has(idxName)) {
            await db.migrationQuery(
              createIndexIfNotExistsSQL(
                q(idxName),
                q(tableName),
                [q(colName)],
                false,
                db.config.type,
              ),
            );
          }
        }
      }
    }

    // Create history table if versioned
    if (meta?.versioned) {
      const historyTable = `${tableName}_history`;
      if (!(await tableExists(db, historyTable))) {
        const columns = meta.columns;
        const colDefs: string[] = [];
        const historyColumnNames = new Set<string>();
        for (const [key, col] of Object.entries(columns)) {
          const colName = (col as any).name || key;
          historyColumnNames.add(colName);
          const sqlType = mapType(
            typeof (col as any).type === "string"
              ? (col as any).type
              : DataTypes[(col as any).type],
            dialect,
          );
          colDefs.push(`${q(colName)} ${sqlType}`);
        }
        const historyText = textType(dialect);
        colDefs.push(`${q("operation")} ${historyText}`);
        // `writeHistory` always inserts a `version` column, so the table has
        // to carry one even when the model declares no version column of its
        // own — otherwise every versioned write fails with "no such column".
        // The loop above already emitted it when the model declares one.
        if (!historyColumnNames.has("version")) {
          colDefs.push(`${q("version")} INTEGER`);
        }
        colDefs.push(`${q("valid_from")} ${historyText}`);
        colDefs.push(`${q("valid_to")} ${historyText}`);
        colDefs.push(`${q("modified_by")} ${historyText}`);
        colDefs.push(`${q("modified_at")} ${historyText}`);
        await db.migrationQuery(
          createTableIfNotExistsSQL(
            q(historyTable),
            colDefs.join(", "),
            db.config.type,
          ),
        );
      }
    }
  }
}

async function createTableFromMeta(
  db: DBClient,
  meta: any,
  tableName: string,
  dialect: "sqlite" | "mysql" | "postgres" | "mssql",
) {
  const colDefs: string[] = [];
  const columns = meta.columns;
  const q = (name: string) => quoteIdentifier(name, db.config.type);

  for (const [key, col] of Object.entries(columns)) {
    const colName = (col as any).name || key;
    const typeName = resolveTypeName((col as any).type);

    if (key === "id") {
      // Only an integer `id` gets the database's auto-increment primary key.
      // A declared STRING/UUID `id` — the pattern in the README, the docs site
      // and what `generate:model` scaffolds — used to be overridden with
      // `INTEGER PRIMARY KEY AUTOINCREMENT` regardless, so every
      // `create({ id: generateUUID() })` failed with "datatype mismatch":
      // SQLite will not store a UUID in a rowid column. Honour the declared
      // type instead, and emit it as the primary key.
      if (isIntegerType(typeName)) {
        colDefs.push(`${q(colName)} ${getAutoIncrementPK(dialect)}`);
        continue;
      }
      const pkParts = [q(colName), mapType(typeName, dialect)];
      // SQLite's one historical quirk: a PRIMARY KEY that is not an INTEGER
      // PRIMARY KEY may still hold NULL, so NOT NULL has to be explicit.
      pkParts.push("NOT NULL", "PRIMARY KEY");
      colDefs.push(pkParts.join(" "));
      continue;
    }

    const parts: string[] = [q(colName)];
    parts.push(mapType(typeName, dialect));
    if ((col as any).required) parts.push("NOT NULL");
    if ((col as any).unique) parts.push("UNIQUE");
    if ((col as any).defaultValue !== undefined) {
      parts.push(`DEFAULT ${JSON.stringify((col as any).defaultValue)}`);
    }
    colDefs.push(parts.join(" "));
  }

  // Timestamps. Skipped when the model already declares the column in
  // `columns` (the documented pattern), which would otherwise produce a
  // duplicate column and make the CREATE TABLE fail.
  if (meta.timestamps) {
    const declared = new Set(
      Object.entries(columns).map(([key, col]: [string, any]) => col.name || key),
    );
    if (meta.timestamps.createdAt && !declared.has(meta.timestamps.createdAt)) {
      colDefs.push(`${q(meta.timestamps.createdAt)} ${textType(dialect)}`);
    }
    if (meta.timestamps.updatedAt && !declared.has(meta.timestamps.updatedAt)) {
      colDefs.push(`${q(meta.timestamps.updatedAt)} ${textType(dialect)}`);
    }
  }

  // Version column
  if (meta.versioned) {
    if (!columns.version) {
      colDefs.push(`${q("version")} INTEGER DEFAULT 1`);
    }
  }

  await db.migrationQuery(
    createTableIfNotExistsSQL(
      q(tableName),
      colDefs.join(", "),
      db.config.type,
    ),
  );
}

async function createTableFromSchema(
  db: DBClient,
  schema: any,
  tableName: string,
  dialect: "sqlite" | "mysql" | "postgres" | "mssql",
) {
  const parts: string[] = [];
  const q = (name: string) => quoteIdentifier(name, db.config.type);
  for (const [col, meta] of Object.entries(schema.columns)) {
    const m = meta as any;
    const dialectMap: Record<string, Record<string, string>> = {
      sqlite: {
        string: "TEXT",
        number: "INTEGER",
        boolean: "INTEGER",
        date: "TEXT",
        json: "TEXT",
      },
      mysql: {
        string: "VARCHAR(255)",
        number: "INT",
        boolean: "TINYINT(1)",
        date: "DATETIME",
        json: "JSON",
      },
      postgres: {
        string: "TEXT",
        number: "INTEGER",
        boolean: "BOOLEAN",
        date: "TIMESTAMP",
        json: "JSONB",
      },
      mssql: {
        string: "NVARCHAR(255)",
        number: "INT",
        boolean: "BIT",
        date: "DATETIME2",
        json: "NVARCHAR(MAX)",
      },
    };
    let sql = `${q(col)} ${dialectMap[dialect]?.[m.type] || "TEXT"}`;
    if (m.primaryKey) sql += " PRIMARY KEY";
    if (m.autoIncrement) {
      sql +=
        dialect === "mysql"
          ? " AUTO_INCREMENT"
          : dialect === "postgres"
            ? " GENERATED ALWAYS AS IDENTITY"
            : dialect === "mssql"
              ? " IDENTITY(1,1)"
              : " AUTOINCREMENT";
    }
    if (!m.nullable) sql += " NOT NULL";
    if (m.default !== undefined) sql += ` DEFAULT ${JSON.stringify(m.default)}`;
    parts.push(sql);
  }
  await db.migrationQuery(
    `CREATE TABLE IF NOT EXISTS ${q(tableName)} (${parts.join(", ")})`,
  );
}

(DBClient.prototype as any).autoMigrate = async function (models: any) {
  return autoMigrate(this, models);
};

export interface SeedDefinition {
  name: string;
  run: (db: DBClient) => Promise<void>;
}

const seeds: SeedDefinition[] = [];

export function defineSeed(name: string, run: (db: DBClient) => Promise<void>) {
  seeds.push({ name, run });
}

export async function runSeeds(
  db: DBClient,
  list?: SeedDefinition[],
): Promise<void> {
  const seedList = list || seeds;
  for (const seed of seedList) {
    await seed.run(db);
  }
}

export async function resetDatabase(
  db: DBClient,
  models: any | any[],
): Promise<void> {
  const list = Array.isArray(models) ? models : [models];
  for (const model of list) {
    const meta = MetadataStorage.getModelMetadata(model);
    const tableName = meta?.tableName || model.schema?.tableName;
    if (tableName) {
      try {
        await db.migrationQuery(
          `DROP TABLE IF EXISTS ${quoteIdentifier(tableName, db.config.type)}`,
        );
      } catch {}
      try {
        await db.migrationQuery(
          `DROP TABLE IF EXISTS ${quoteIdentifier(`${tableName}_history`, db.config.type)}`,
        );
      } catch {}
    }
  }
  await autoMigrate(db, list);
}
