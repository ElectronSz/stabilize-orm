/**
 * @file auto-migrate.ts
 * @description Adds GORM-like AutoMigrate to Stabilize ORM with index and constraint management.
 */

import { DBClient } from "./client";
import { DBType, StabilizeError } from "./types";

type ColumnType = "string" | "number" | "boolean" | "date" | "json";

export interface ModelSchema {
  tableName: string;
  columns: Record<
    string,
    {
      type: ColumnType;
      primaryKey?: boolean;
      autoIncrement?: boolean;
      nullable?: boolean;
      default?: any;
      index?: string | boolean;
      unique?: boolean;
    }
  >;
  indexes?: Array<{
    name: string;
    columns: string[];
    unique?: boolean;
  }>;
}

function sqlType(
  type: ColumnType,
  dialect: "sqlite" | "mysql" | "postgres",
): string {
  switch (dialect) {
    case "sqlite":
      return {
        string: "TEXT",
        number: "INTEGER",
        boolean: "INTEGER",
        date: "TEXT",
        json: "TEXT",
      }[type]!;
    case "mysql":
      return {
        string: "VARCHAR(255)",
        number: "INT",
        boolean: "TINYINT(1)",
        date: "DATETIME",
        json: "JSON",
      }[type]!;
    case "postgres":
      return {
        string: "TEXT",
        number: "INTEGER",
        boolean: "BOOLEAN",
        date: "TIMESTAMP",
        json: "JSONB",
      }[type]!;
  }
}

async function getExistingColumns(
  db: DBClient,
  table: string,
): Promise<Set<string>> {
  switch (db.config.type) {
    case DBType.SQLite:
      const rows = await db.query<any>(`PRAGMA table_info(${table});`);
      return new Set(rows.map((r: any) => r.name));
    case DBType.MySQL:
      const cols = await db.query<any>(`SHOW COLUMNS FROM \`${table}\`;`);
      return new Set(cols.map((c: any) => c.Field));
    case DBType.Postgres:
      const pgCols = await db.query<any>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      return new Set(pgCols.map((c: any) => c.column_name));
    default:
      throw new StabilizeError("Unknown DB type", "MIGRATE_ERROR");
  }
}

async function getExistingIndexes(
  db: DBClient,
  table: string,
): Promise<Map<string, { columns: string[]; unique: boolean }>> {
  const indexes = new Map<string, { columns: string[]; unique: boolean }>();
  switch (db.config.type) {
    case DBType.SQLite: {
      const rows = await db.query<any>(`PRAGMA index_list(${table});`);
      for (const row of rows) {
        if (row.origin === "u" || row.origin === "c") continue;
        const info = await db.query<any>(`PRAGMA index_info('${row.name}');`);
        indexes.set(row.name, {
          columns: info.map((i: any) => i.name),
          unique: !!row.unique,
        });
      }
      break;
    }
    case DBType.MySQL: {
      const rows = await db.query<any>(`SHOW INDEX FROM \`${table}\`;`);
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
          indexes.set(row.index_name, {
            columns: [],
            unique: row.indisunique,
          });
        }
        indexes.get(row.index_name)!.columns.push(row.column_name);
      }
      break;
    }
  }
  return indexes;
}

export function extractSchema(model: any): ModelSchema {
  if (!model.schema)
    throw new StabilizeError(
      `Model "${model.name}" is missing static schema property.`,
      "MIGRATE_ERROR",
    );
  if (!model.schema.tableName)
    throw new StabilizeError(
      `Model "${model.name}" schema missing tableName.`,
      "MIGRATE_ERROR",
    );

  return model.schema as ModelSchema;
}

function buildCreateTable(
  schema: ModelSchema,
  dialect: "sqlite" | "mysql" | "postgres",
) {
  const parts: string[] = [];

  for (const [col, meta] of Object.entries(schema.columns)) {
    let sql = `"${col}" ${sqlType(meta.type, dialect)}`;

    if (meta.primaryKey) sql += " PRIMARY KEY";

    if (meta.autoIncrement) {
      sql +=
        dialect === "mysql"
          ? " AUTO_INCREMENT"
          : dialect === "postgres"
            ? " GENERATED ALWAYS AS IDENTITY"
            : " AUTOINCREMENT";
    }

    if (!meta.nullable) sql += " NOT NULL";

    if (meta.default !== undefined)
      sql += ` DEFAULT ${JSON.stringify(meta.default)}`;

    parts.push(sql);
  }

  return `CREATE TABLE IF NOT EXISTS "${schema.tableName}" (${parts.join(", ")})`;
}

function buildAddColumn(
  table: string,
  col: string,
  meta: any,
  dialect: "sqlite" | "mysql" | "postgres",
): string {
  return `ALTER TABLE "${table}" ADD COLUMN "${col}" ${sqlType(
    meta.type,
    dialect,
  )} ${meta.nullable ? "" : "NOT NULL"}`;
}

function buildCreateIndex(
  table: string,
  indexName: string,
  columns: string[],
  unique: boolean,
  dialect: "sqlite" | "mysql" | "postgres",
): string {
  const uniqueStr = unique ? "UNIQUE " : "";
  const colStr = columns.map((c) => `"${c}"`).join(", ");
  return `CREATE ${uniqueStr}INDEX IF NOT EXISTS "${indexName}" ON "${table}" (${colStr})`;
}

function buildDropIndex(
  indexName: string,
  dialect: "sqlite" | "mysql" | "postgres",
): string {
  if (dialect === "mysql") {
    return `ALTER TABLE DROP INDEX \`${indexName}\``;
  }
  return `DROP INDEX IF EXISTS "${indexName}"`;
}

function generateIndexName(
  table: string,
  columns: string[],
  suffix: string = "idx",
): string {
  return `${table}_${columns.join("_")}_${suffix}`;
}

export async function autoMigrate(
  db: DBClient,
  models: any | any[],
): Promise<void> {
  const list = Array.isArray(models) ? models : [models];
  const dialect =
    db.config.type === DBType.SQLite
      ? "sqlite"
      : db.config.type === DBType.MySQL
        ? "mysql"
        : "postgres";

  for (const model of list) {
    const schema = extractSchema(model);

    const existing = await getExistingColumns(db, schema.tableName);
    const existingIndexes = await getExistingIndexes(db, schema.tableName);

    if (existing.size === 0) {
      const createSQL = buildCreateTable(schema, dialect);
      await db.migrationQuery(createSQL);
    } else {
      for (const [col, meta] of Object.entries(schema.columns)) {
        if (!existing.has(col)) {
          const alter = buildAddColumn(schema.tableName, col, meta, dialect);
          await db.migrationQuery(alter);
        }
      }
    }

    const desiredIndexes = new Map<
      string,
      { columns: string[]; unique: boolean }
    >();

    for (const [col, meta] of Object.entries(schema.columns)) {
      if (meta.index && typeof meta.index === "string") {
        desiredIndexes.set(meta.index, {
          columns: [col],
          unique: !!meta.unique,
        });
      } else if (meta.index === true) {
        const idxName = generateIndexName(schema.tableName, [col]);
        desiredIndexes.set(idxName, { columns: [col], unique: false });
      }
      if (meta.unique && !meta.primaryKey) {
        const idxName = generateIndexName(schema.tableName, [col], "uniq");
        desiredIndexes.set(idxName, { columns: [col], unique: true });
      }
    }

    if (schema.indexes) {
      for (const idx of schema.indexes) {
        desiredIndexes.set(idx.name, {
          columns: idx.columns,
          unique: !!idx.unique,
        });
      }
    }

    for (const [idxName, idxMeta] of desiredIndexes) {
      if (!existingIndexes.has(idxName)) {
        const createIdx = buildCreateIndex(
          schema.tableName,
          idxName,
          idxMeta.columns,
          idxMeta.unique,
          dialect,
        );
        await db.migrationQuery(createIdx);
      }
    }

    for (const [existingIdxName, existingIdxMeta] of existingIndexes) {
      let found = false;
      for (const [desiredName, desiredMeta] of desiredIndexes) {
        if (existingIdxName === desiredName) {
          found = true;
          break;
        }
        if (
          JSON.stringify(existingIdxMeta.columns.sort()) ===
            JSON.stringify(desiredMeta.columns.sort()) &&
          existingIdxMeta.unique === desiredMeta.unique
        ) {
          found = true;
          break;
        }
      }
      if (!found) {
        const dropIdx = buildDropIndex(existingIdxName, dialect);
        await db.migrationQuery(dropIdx);
      }
    }
  }
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
    const schema = extractSchema(model);
    try {
      await db.migrationQuery(`DROP TABLE IF EXISTS "${schema.tableName}"`);
    } catch {}
    try {
      await db.migrationQuery(
        `DROP TABLE IF EXISTS "${schema.tableName}_history"`,
      );
    } catch {}
  }
  await autoMigrate(db, list);
}
