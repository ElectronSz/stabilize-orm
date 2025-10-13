import { DBClient } from "./client";
import { ModelKey, ColumnKey, ValidatorKey, SoftDeleteKey } from "./decorators";
import { type DBConfig, type Migration, StabilizeError } from "./types";

type ColumnData = { name: string; type: string };
type ColumnMetadata = Record<string, ColumnData>;
type ValidatorMetadata = Record<string, string[]>;

export async function generateMigration(
  model: new (...args: any[]) => any,
  name: string,
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
    let def = `${col.name} ${col.type}`;
    if (col.name === "id") def += " PRIMARY KEY AUTOINCREMENT";
    if (validators[key]?.includes("required")) def += " NOT NULL";
    if (validators[key]?.includes("unique")) def += " UNIQUE";
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

export async function runMigrations(config: DBConfig, migrations: Migration[]) {
  const client = new DBClient(config);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

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
