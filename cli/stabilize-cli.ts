#!/usr/bin/env bun
import 'reflect-metadata';  // MUST BE FIRST — Enables decorator metadata reflection

import { program } from "commander";
import {
  generateMigration,
  Stabilize,
  runMigrations,
  ModelKey
} from "../";
import { LogLevel, type DBConfig, type LoggerConfig, DBType } from "../types";
import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";

// --- ANSI Color and Styling Helpers ---
const C = {
  RESET: "\x1b[0m",
  BRIGHT: "\x1b[1m",
  DIM: "\x1b[2m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[37m",
  BG_GREEN: "\x1b[42m\x1b[30m",
  BG_RED: "\x1b[41m\x1b[37m",
  BG_YELLOW: "\x1b[43m\x1b[30m",
};

// DB-aware migrations table
function getMigrationsTableSQL(dbType: DBType) {
  switch (dbType) {
    case DBType.Postgres:
      return `CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMP NOT NULL
      )`;
    case DBType.MySQL:
      return `CREATE TABLE IF NOT EXISTS migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at DATETIME NOT NULL
      )`;
    case DBType.SQLite:
    default:
      return `CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )`;
  }
}
function getSeedHistoryTableSQL(dbType: DBType) {
  switch (dbType) {
    case DBType.Postgres:
      return `CREATE TABLE IF NOT EXISTS seed_history (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMP NOT NULL
      )`;
    case DBType.MySQL:
      return `CREATE TABLE IF NOT EXISTS seed_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at DATETIME NOT NULL
      )`;
    case DBType.SQLite:
    default:
      return `CREATE TABLE IF NOT EXISTS seed_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )`;
  }
}

// Helper function to load configuration
async function loadConfig(configPath: string): Promise<{ config: DBConfig; loggerConfig: LoggerConfig; orm: Stabilize }> {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const configModule = await import(absoluteConfigPath);
  const config: DBConfig = configModule.default || configModule;
  const logLevel = program.opts().logLevel as LogLevel || "info";
  const loggerConfig: LoggerConfig = {
    level: logLevel,
    filePath: path.resolve(process.cwd(), "logs/stabilize.log"),
    maxFileSize: 5 * 1024 * 1024,
    maxFiles: 3,
  };
  const orm = new Stabilize(
    config,
    { enabled: false, ttl: 60 },
    loggerConfig,
  );
  return { config, loggerConfig, orm };
}

// --------------------------------------------------------------------------------------------------
// COMMAND: GENERATE
// --------------------------------------------------------------------------------------------------

program
  .command("generate <type> <name>")
  .description("Generate a model, migration, or seed file")
  .option("-l, --log-level <level>", "Log level (error, warn, info, debug)", "info")
  .action(async (type: string, name: string) => {
    try {
      if (type === "migration") {
        const modelPath = path.resolve(process.cwd(), "models", `${name}.ts`);
        let modelClass: any;
        try {
          const modelModule = await import(modelPath);
          modelClass = Object.values(modelModule).find(val => typeof val === "function" && val.prototype);
          if (!modelClass) throw new Error("No class exported in model file.");
        } catch (err: any) {
          console.error(`${C.BG_RED} ERROR ${C.RESET} Failed to import model: ${modelPath}. Ensure file exists and is valid. Details: ${err.message}`);
          return;
        }
        const tableName = Reflect.getMetadata(ModelKey, modelClass);
        console.log("Errors are calculated", tableName)
        if (!tableName) {
          console.error(`${C.BG_RED} ERROR ${C.RESET} Model class '${name}' in ${modelPath} is not decorated with @Model or metadata is missing.`);
          console.log(`${C.YELLOW} TIP ${C.RESET} - Ensure @Model('${name.toLowerCase()}s') is on the class.\n    - Regenerate with 'generate model ${name}'.\n    - Import 'reflect-metadata' in your model file or entry point if needed.`);
          return;
        }
        // Determine dbType
        const dbType = (await loadConfig("config/database.ts")).config.type ?? DBType.SQLite;
        let migration: any;
        try {
          migration = await generateMigration(modelClass, `create_${name.toLowerCase()}`);
        } catch (genErr: any) {
          console.error(`${C.BG_RED} ERROR ${C.RESET} Migration generation failed: ${genErr.message}`);
          if (genErr.message.includes('decorated') || genErr.message.includes('Model')) {
            console.log(`${C.YELLOW} TIP ${C.RESET} Ensure reflect-metadata is installed and imported globally.`);
          }
          return;
        }
        const migrationDir = path.resolve(process.cwd(), "migrations");
        await fs.mkdir(migrationDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
        const migrationFileName = `${timestamp}_${name.toLowerCase()}`;
        const migrationFile = path.join(migrationDir, `${migrationFileName}.ts`);
        const migrationContent = `
import { Migration } from 'stabilize-orm/src/types';

const migration: Migration = {
  name: '${migrationFileName}',
  up: async (client: any) => {
    ${migration.up.map((q: string) => `await client.query(\`${q}\`);`).join("\n    ")}
  },
  down: async (client: any) => {
    ${migration.down.map((q: string) => `await client.query(\`${q}\`);`).join("\n    ")}
  }
};

export default migration;
        `.trim();
        await fs.writeFile(migrationFile, migrationContent + "\n");
        console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Migration generated: ${C.GREEN}${migrationFile}${C.RESET}`);

      } else if (type === "model") {
        const modelDir = path.resolve(process.cwd(), "models");
        await fs.mkdir(modelDir, { recursive: true });
        const modelFile = path.join(modelDir, `${name}.ts`);
        const modelContent = `
import 'reflect-metadata';  // Required for decorators
import { Model, Column, Required } from 'stabilize-orm';

@Model('${name.toLowerCase()}s')
export class ${name} {
  @Column('id', 'TEXT', { primaryKey: true })
  @Required()
  id: string = crypto.randomUUID();

  @Column('name', 'TEXT')
  @Required()
  name?: string;

  @Column('created_at', 'TEXT')
  createdAt?: string;

  @Column('updated_at', 'TEXT')
  updatedAt?: string;
}
        `.trim() + "\n";
        await fs.writeFile(modelFile, modelContent);
        console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Model generated: ${C.GREEN}${modelFile}${C.RESET}`);

      } else if (type === "seed") {
        const seedDir = path.resolve(process.cwd(), "seeds");
        await fs.mkdir(seedDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
        const seedFileName = `${timestamp}_${name.toLowerCase()}`;
        const seedFile = path.join(seedDir, `${seedFileName}.ts`);
        const seedContent = `
import { Stabilize } from 'stabilize-orm';
import { ${name} } from '../models/${name}';
import { randomUUID } from 'crypto';

export const dependencies: string[] = [];

// Use UUIDs in seed data
export async function seed(orm: Stabilize) {
  const repo = orm.getRepository(${name});
  await repo.bulkCreate([
    { id: randomUUID(), name: '${name} 1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: randomUUID(), name: '${name} 2', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  ], { batchSize: 100 });

  await orm.client.query(
    \`INSERT INTO seed_history (name, applied_at) VALUES (?, ?)\`,
    ['${seedFileName}', new Date().toISOString()]
  );
}

export async function rollback(orm: Stabilize) {
  const repo = orm.getRepository(${name});
  const entities = await repo.find().execute(orm.client);
  const ids = entities.map((e: any) => e.id).filter(Boolean);
  if (ids.length > 0) {
    await repo.bulkDelete(ids, { batchSize: 100 });
  }

  await orm.client.query(
    \`DELETE FROM seed_history WHERE name = ?\`,
    ['${seedFileName}']
  );
}
        `.trim() + "\n";
        await fs.writeFile(seedFile, seedContent);
        console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Seed generated: ${C.GREEN}${seedFile}${C.RESET}`);

      } else {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Invalid type. Use ${C.YELLOW}"model", "migration", or "seed"${C.RESET}.`);
      }
    } catch (error: any) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Error generating file:`, error.message);
    }
  });

// --------------------------------------------------------------------------------------------------
// COMMAND: MIGRATE
// --------------------------------------------------------------------------------------------------

program
  .command("migrate")
  .description("Apply all pending migrations")
  .option("-c, --config <path>", "Path to database config file", "config/database.ts")
  .option("-l, --log-level <level>", "Log level (error, warn, info, debug)", "info")
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { orm: loadedOrm, config } = await loadConfig(options.config);
      orm = loadedOrm;
      const dbType = config.type ?? DBType.SQLite;
      await orm.client.query(getMigrationsTableSQL(dbType));

      const migrationDir = path.resolve(process.cwd(), "migrations");
      const migrationFiles = (await glob(`${migrationDir}/*.ts`)).sort();
      const migrations = [];
      for (const file of migrationFiles) {
        const migrationName = path.basename(file, ".ts");
        const applied = await orm.client.query(`SELECT name FROM migrations WHERE name = ?`, [migrationName]);
        if (applied.length > 0) continue;
        let migrationModule;
        try {
          migrationModule = await import(file);
        } catch (err) {
          console.error(`Failed to load migration ${file}:`, err);
          continue;
        }
        const migration = migrationModule.default || migrationModule;
        if (!migration || typeof migration.up !== "function") {
          console.warn(`Invalid migration format in ${file}. Skipping.`);
          continue;
        }
        migrations.push({ name: migrationName, up: migration.up });
      }
      if (migrations.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No pending migrations found.`);
        await orm.close();
        return;
      }
      console.log(`${C.BLUE} INFO ${C.RESET} Applying ${C.BRIGHT}${migrations.length}${C.RESET} migration(s)...`);
      for (const mig of migrations) {
        console.log(`  Applying: ${C.CYAN}${mig.name}${C.RESET}`);
        await orm.transaction(async () => {
          await mig.up(orm?.client);
          await orm?.client.query(
            `INSERT INTO migrations (name, applied_at) VALUES (?, ?)`,
            [mig.name, new Date().toISOString()]
          );
        });
      }
      console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} All migrations applied successfully.`);
      await orm.close();

    } catch (error: any) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Migration failed:`, error.message);
      if (orm) await orm.close();
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------------------------------
// COMMAND: MIGRATE:ROLLBACK
// --------------------------------------------------------------------------------------------------

program
  .command("migrate:rollback")
  .description("Rollback the most recently applied migration")
  .option("-c, --config <path>", "Path to database config file", "config/database.ts")
  .option("-l, --log-level <level>", "Log level (error, warn, info, debug)", "info")
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { orm: loadedOrm, config } = await loadConfig(options.config);
      orm = loadedOrm;
      const dbType = config.type ?? DBType.SQLite;
      await orm.client.query(getMigrationsTableSQL(dbType));

      const latest = await orm.client.query(
        `SELECT name FROM migrations ORDER BY applied_at DESC LIMIT 1`
      );
      if (latest.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No migrations to rollback.`);
        await orm.close();
        return;
      }
      const migrationName = latest[0].name;
      const migrationFile = path.resolve(process.cwd(), "migrations", `${migrationName}.ts`);
      let migrationModule;
      try {
        migrationModule = await import(migrationFile);
      } catch (err) {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Migration file not found: ${migrationFile}`);
        await orm.close();
        return;
      }
      const migration = migrationModule.default || migrationModule;
      if (typeof migration.down !== "function") {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Migration ${migrationName} missing down function.`);
        await orm.close();
        return;
      }
      console.log(`${C.BLUE} INFO ${C.RESET} Rolling back: ${C.YELLOW}${migrationName}${C.RESET}`);
      await orm.transaction(async () => {
        await migration.down(orm?.client);
        await orm?.client.query(`DELETE FROM migrations WHERE name = ?`, [migrationName]);
      });
      console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Rolled back: ${C.GREEN}${migrationName}${C.RESET}`);
      await orm.close();

    } catch (error: any) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Rollback failed:`, error.message);
      if (orm) await orm.close();
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------------------------------
// COMMAND: SEED
// --------------------------------------------------------------------------------------------------

program
  .command("seed")
  .description("Run seed files to populate the database")
  .option("-c, --config <path>", "Path to database config file", "config/database.ts")
  .option("-l, --log-level <level>", "Log level (error, warn, info, debug)", "info")
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { orm: loadedOrm, config } = await loadConfig(options.config);
      orm = loadedOrm;
      const dbType = config.type ?? DBType.SQLite;
      await orm.client.query(getSeedHistoryTableSQL(dbType));

      const seedDir = path.resolve(process.cwd(), "seeds");
      const seedFiles = await glob(`${seedDir}/*.ts`);
      if (seedFiles.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No seed files found.`);
        await orm.close();
        return;
      }
      const seedGraph = new Map<string, { file: string; dependencies: string[] }>();
      for (const file of seedFiles) {
        const seedName = path.basename(file, ".ts");
        let mod;
        try {
          mod = await import(file);
        } catch (err) {
          console.warn(`Failed to load seed ${file}:`, err);
          continue;
        }
        seedGraph.set(seedName, {
          file,
          dependencies: mod.dependencies || [],
        });
      }
      const orderedSeeds = topologicalSort(seedGraph);

      let appliedCount = 0;
      for (const seedName of orderedSeeds) {
        const { file } = seedGraph.get(seedName)!;
        const alreadyApplied = await orm.client.query(`SELECT 1 FROM seed_history WHERE name = ?`, [seedName]);
        if (alreadyApplied.length > 0) {
          console.log(`  ${C.DIM}Skipped:${C.RESET} ${seedName}`);
          continue;
        }
        console.log(`  ${C.BRIGHT}Running:${C.RESET} ${C.MAGENTA}${seedName}${C.RESET}`);
        const mod = await import(file);
        const seedFn = mod.seed || mod.default;
        if (typeof seedFn === "function") {
          await seedFn(orm);
          await orm.client.query(
            `INSERT INTO seed_history (name, applied_at) VALUES (?, ?)`,
            [seedName, new Date().toISOString()]
          );
          appliedCount++;
        } else {
          console.error(`${C.BG_RED} ERROR ${C.RESET} Invalid seed export in ${file}`);
        }
      }
      console.log(`\n${C.BG_GREEN} SUCCESS ${C.RESET} Seeding complete. Applied: ${appliedCount}`);
      await orm.close();

    } catch (error: any) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Seeding failed:`, error.message);
      if (orm) await orm.close();
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------------------------------
// COMMAND: SEED:ROLLBACK
// --------------------------------------------------------------------------------------------------

program
  .command("seed:rollback")
  .description("Rollback the most recently applied seed")
  .option("-c, --config <path>", "Path to database config file", "config/database.ts")
  .option("-l, --log-level <level>", "Log level (error, warn, info, debug)", "info")
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { orm: loadedOrm, config } = await loadConfig(options.config);
      orm = loadedOrm;
      const dbType = config.type ?? DBType.SQLite;
      await orm.client.query(getSeedHistoryTableSQL(dbType));

      const latest = await orm.client.query(`SELECT name FROM seed_history ORDER BY applied_at DESC LIMIT 1`);
      if (latest.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No seeds to rollback.`);
        await orm.close();
        return;
      }
      const seedName = latest[0].name;
      const seedFile = path.resolve(process.cwd(), "seeds", `${seedName}.ts`);
      let mod;
      try {
        mod = await import(seedFile);
      } catch (err) {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Seed file not found: ${seedFile}`);
        await orm.close();
        return;
      }
      const rollbackFn = mod.rollback;
      if (typeof rollbackFn !== "function") {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Missing rollback function in ${seedName}`);
        await orm.close();
        return;
      }
      console.log(`${C.BLUE} INFO ${C.RESET} Rolling back seed: ${C.YELLOW}${seedName}${C.RESET}`);
      await rollbackFn(orm);
      await orm.client.query(`DELETE FROM seed_history WHERE name = ?`, [seedName]);
      console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Seed rolled back: ${C.GREEN}${seedName}${C.RESET}`);
      await orm.close();

    } catch (error: any) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Rollback failed:`, error.message);
      if (orm) await orm.close();
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------------------------------
// COMMAND: STATUS
// --------------------------------------------------------------------------------------------------

program
  .command("status")
  .description("Display status of migrations and seeds")
  .option("-c, --config <path>", "Path to database config file", "config/database.ts")
  .option("-l, --log-level <level>", "Log level (error, warn, info, debug)", "info")
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { orm: loadedOrm, config } = await loadConfig(options.config);
      orm = loadedOrm;
      const dbType = config.type ?? DBType.SQLite;
      await orm.client.query(getMigrationsTableSQL(dbType));
      await orm.client.query(getSeedHistoryTableSQL(dbType));

      const migrationDir = path.resolve(process.cwd(), "migrations");
      const migrationFiles = (await glob(`${migrationDir}/*.ts`)).map(f => path.basename(f, ".ts")).sort();
      console.log(`\n${C.BRIGHT}Migration Status:${C.RESET}`);
      console.log(`---------------------------------`);
      for (const name of migrationFiles) {
        const res = await orm.client.query(`SELECT 1 FROM migrations WHERE name = ?`, [name]);
        const status = res.length > 0 ? `${C.BG_GREEN} APPLIED ${C.RESET}` : `${C.BG_YELLOW} PENDING ${C.RESET}`;
        console.log(`${status} ${C.WHITE}${name}${C.RESET}`);
      }
      const seedDir = path.resolve(process.cwd(), "seeds");
      const seedFiles = (await glob(`${seedDir}/*.ts`)).map(f => path.basename(f, ".ts")).sort();
      console.log(`\n${C.BRIGHT}Seed Status:${C.RESET}`);
      console.log(`---------------------------------`);
      for (const name of seedFiles) {
        const res = await orm.client.query(`SELECT 1 FROM seed_history WHERE name = ?`, [name]);
        const status = res.length > 0 ? `${C.BG_GREEN} APPLIED ${C.RESET}` : `${C.BG_YELLOW} PENDING ${C.RESET}`;
        console.log(`${status} ${C.WHITE}${name}${C.RESET}`);
      }
      await orm.close();
    } catch (error: any) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Status check failed:`, error.message);
      if (orm) await orm.close();
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------------------------------
// TOPOLOGICAL SORT HELPER
// --------------------------------------------------------------------------------------------------

function topologicalSort(
  graph: Map<string, { file: string; dependencies: string[] }>,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const temp = new Set<string>();
  function visit(node: string) {
    if (temp.has(node)) throw new Error(`Circular dependency detected: ${node}`);
    if (!visited.has(node)) {
      temp.add(node);
      const deps = graph.get(node)?.dependencies || [];
      for (const dep of deps) {
        if (!graph.has(dep)) throw new Error(`Dependency ${dep} not found for ${node}`);
        visit(dep);
      }
      temp.delete(node);
      visited.add(node);
      result.push(node);
    }
  }
  for (const node of graph.keys()) {
    if (!visited.has(node)) visit(node);
  }
  return result;
}

program.parse(process.argv);