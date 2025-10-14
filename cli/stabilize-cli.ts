#!/usr/bin/env bun
import { program } from "commander";
import {
  generateMigration,
  Stabilize,
  DBType,
  type DBConfig,
  LogLevel,
  type LoggerConfig,
  runMigrations, // Added runMigrations import
} from "../src";
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
  BG_GREEN: "\x1b[42m\x1b[30m", // Black text on Green background
  BG_RED: "\x1b[41m\x1b[37m",   // White text on Red background
  BG_YELLOW: "\x1b[43m\x1b[30m",// Black text on Yellow background
};


program.version("1.0.5").description("Stabilize ORM CLI");

// Helper function to load configuration
async function loadConfig(configPath: string): Promise<{ config: DBConfig, loggerConfig: LoggerConfig, orm: Stabilize }> {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const configModule = await import(absoluteConfigPath);
  const config: DBConfig = configModule.default || configModule;

  const logLevel = program.opts().logLevel as LogLevel;

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
  .option(
    "-l, --log-level <level>",
    "Log level (error, warn, info, debug)",
    "info",
  )
  .action(async (type: string, name: string) => {
    try {
      if (type === "migration") {
        const modelPath = path.resolve(process.cwd(), "models", `${name}.ts`);
        const modelModule = await import(modelPath);
        const model = Object.values(modelModule)[0] as new (
          ...args: any[]
        ) => any;
        const migration = await generateMigration(
          model,
          `create_${name.toLowerCase()}`,
        );
        const migrationDir = path.resolve(process.cwd(), "migrations");
        await fs.mkdir(migrationDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[-:T.]/g, "");
        const migrationFile = path.join(
          migrationDir,
          `${timestamp}_${name.toLowerCase()}.ts`,
        );
        await fs.writeFile(
          migrationFile,
          `import { Migration } from 'stabilize-orm/src/types';\n\nconst migration: Migration = ${JSON.stringify(migration, null, 2)};\n\nexport default migration;`,
        );
        console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Migration generated: ${C.GREEN}${migrationFile}${C.RESET}`);

      } else if (type === "model") {
        const modelDir = path.resolve(process.cwd(), "models");
        await fs.mkdir(modelDir, { recursive: true });
        const modelFile = path.join(modelDir, `${name}.ts`);
        const modelContent = `
import { Model, Column, Required } from 'stabilize-orm';

@Model('${name.toLowerCase()}s')
export class ${name} {
  @Column('id', 'INTEGER')
  id?: number;

  @Column('name', 'TEXT')
  @Required()
  name: string;
}
`;
        await fs.writeFile(modelFile, modelContent);
        console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Model generated: ${C.GREEN}${modelFile}${C.RESET}`);

      } else if (type === "seed") {
        const seedDir = path.resolve(process.cwd(), "seeds");
        await fs.mkdir(seedDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[-:T.]/g, "");
        const seedFile = path.join(
          seedDir,
          `${timestamp}_${name.toLowerCase()}.ts`,
        );
        const seedContent = `
import { Stabilize } from 'stabilize-orm';
import { ${name} } from '../models/${name}'; // Assuming model path

export const dependencies = [];

export async function seed(orm: Stabilize) {
  const repo = orm.getRepository(${name});
  await repo.bulkCreate([
    { name: '${name} 1' },
    { name: '${name} 2' },
  ], { batchSize: 100 });

  await orm['client'].query(
    \`INSERT INTO seed_history (name, applied_at) VALUES (?, ?)\`,
    ['${timestamp}_${name.toLowerCase()}', new Date().toISOString()]
  );
}

export async function rollback(orm: Stabilize) {
  const repo = orm.getRepository(${name});
  // NOTE: This rollback logic assumes your entities have an 'id' field for deletion.
  const entities = await repo.find().execute(orm['client']); 
  await repo.bulkDelete(entities.map(e => e.id!), { batchSize: 100 }); 

  await orm['client'].query(
    \`DELETE FROM seed_history WHERE name = ?\`,
    ['${timestamp}_${name.toLowerCase()}']
  );
}
`;
        await fs.writeFile(seedFile, seedContent);
        console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Seed generated: ${C.GREEN}${seedFile}${C.RESET}`);
      } else {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Invalid type. Use ${C.YELLOW}"model", "migration", or "seed"${C.RESET}.`);
      }
    } catch (error) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Error generating file:`, error);
    }
  });


// --------------------------------------------------------------------------------------------------
// COMMAND: MIGRATE
// --------------------------------------------------------------------------------------------------

program
  .command("migrate")
  .description("Apply all pending migrations")
  .option(
    "-c, --config <path>",
    "Path to database config file",
    "config/database.ts",
  )
  .option(
    "-l, --log-level <level>",
    "Log level (error, warn, info, debug)",
    "info",
  )
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { config } = await loadConfig(options.config);

      // Re-initialize ORM with correct logging configuration
      orm = new Stabilize(config, { enabled: false, ttl: 60 }, { level: options.logLevel as LogLevel });

      const migrationDir = path.resolve(process.cwd(), "migrations");
      const migrationFiles = await glob(`${migrationDir}/*.ts`);
      
      const migrations = [];
      for (const file of migrationFiles.sort()) {
        const migrationModule = await import(file);
        // Assuming migration files export a default object with { up: string[], down: string[] }
        migrations.push(migrationModule.default || migrationModule);
      }

      if (migrations.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No migration files found in migrations/ directory.`);
        await orm.close();
        return;
      }
      
      console.log(`${C.BLUE} INFO ${C.RESET} Running ${C.BRIGHT}${migrations.length}${C.RESET} migration files...`);
      
      // runMigrations handles applying only the unapplied ones.
      await runMigrations(config, migrations);
      
      console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Migrations completed successfully.`);
      await orm.close();

    } catch (error) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Migration failed:`, error);
      if (orm) await orm.close();
      process.exit(1);
    }
  });


// --------------------------------------------------------------------------------------------------
// COMMAND: MIGRATE:ROLLBACK (One step back)
// --------------------------------------------------------------------------------------------------

program
  .command("migrate:rollback")
  .description("Rollback the most recently applied migration")
  .option(
    "-c, --config <path>",
    "Path to database config file",
    "config/database.ts",
  )
  .option(
    "-l, --log-level <level>",
    "Log level (error, warn, info, debug)",
    "info",
  )
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { config } = await loadConfig(options.config);
      orm = new Stabilize(config, { enabled: false, ttl: 60 }, { level: options.logLevel as LogLevel });

      // 1. Get the last applied migration record from the DB
      const latestApplied = await orm["client"].query<{ name: string }>(
        `SELECT name FROM migrations ORDER BY applied_at DESC LIMIT 1`,
      );

      if (latestApplied.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No migrations to rollback.`);
        await orm.close();
        return;
      }

      const migrationName = latestApplied[0]!.name;
      const migrationDir = path.resolve(process.cwd(), "migrations");
      const migrationFiles = await glob(`${migrationDir}/*.ts`);

      // 2. Find the corresponding file
      const migrationFile = migrationFiles.find(f => path.basename(f, '.ts') === migrationName);

      if (!migrationFile) {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Migration file for ${migrationName} not found.`);
        await orm.close();
        return;
      }

      // 3. Load the rollback (down) query
      const migrationModule = await import(migrationFile);
      const migration = migrationModule.default || migrationModule;
      const downQueries: string[] = migration.down;

      if (!downQueries || downQueries.length === 0) {
         console.error(`${C.BG_RED} ERROR ${C.RESET} Migration ${migrationName} does not contain a 'down' array for rollback.`);
         await orm.close();
         return;
      }

      console.log(`${C.BLUE} INFO ${C.RESET} Rolling back migration: ${C.YELLOW}${migrationName}${C.RESET}`);

      // 4. Run the down queries inside a transaction (best practice)
      await orm.transaction(async () => {
        for (const query of downQueries) {
          await orm!['client'].query(query, []);
        }
        // 5. Remove the migration record from the history table
        await orm!["client"].query(
          `DELETE FROM migrations WHERE name = ?`,
          [migrationName],
        );
      });

      console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Rolled back migration: ${C.GREEN}${migrationName}${C.RESET}`);
      await orm.close();

    } catch (error) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Migration rollback failed:`, error);
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
  .option(
    "-c, --config <path>",
    "Path to database config file",
    "config/database.ts",
  )
  .option(
    "-l, --log-level <level>",
    "Log level (error, warn, info, debug)",
    "info",
  )
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { config } = await loadConfig(options.config);
      orm = new Stabilize(config, { enabled: false, ttl: 60 }, { level: options.logLevel as LogLevel });

      await orm["client"].query(`
        CREATE TABLE IF NOT EXISTS seed_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      const seedDir = path.resolve(process.cwd(), "seeds");
      const seedFiles = await glob(`${seedDir}/*.ts`);
      if (seedFiles.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No seed files found in seeds/ directory.`);
        await orm.close();
        return;
      }

      const seedGraph = new Map<
        string,
        { file: string; dependencies: string[] }
      >();
      for (const file of seedFiles) {
        const seedName = path.basename(file, ".ts");
        const seedModule = await import(file);
        seedGraph.set(seedName, {
          file,
          dependencies: seedModule.dependencies || [],
        });
      }

      const orderedSeeds = topologicalSort(seedGraph);

      console.log(`${C.BLUE} INFO ${C.RESET} Running ${C.BRIGHT}${orderedSeeds.length}${C.RESET} seed files (sorted by dependency)...`);
      let seedsApplied = 0;
      for (const seedName of orderedSeeds) {
        const { file } = seedGraph.get(seedName)!;
        const applied = await orm["client"].query<{ id: number }>(
          `SELECT id FROM seed_history WHERE name = ?`,
          [seedName],
        );
        if (applied.length > 0) {
          console.log(`  ${C.DIM}Skipping already applied seed:${C.RESET} ${seedName}`);
          continue;
        }

        console.log(`  ${C.BRIGHT}Executing seed:${C.RESET} ${C.MAGENTA}${seedName}${C.RESET}`);
        const seedModule = await import(file);
        const seedFn = seedModule.default || seedModule.seed;
        if (typeof seedFn === "function") {
          await seedFn(orm);
          seedsApplied++;
        } else {
          console.error(
            `${C.BG_RED} ERROR ${C.RESET} Seed file ${file} must export a default function or a function named 'seed'.`,
          );
        }
      }

      console.log(`\n${C.BG_GREEN} SUCCESS ${C.RESET} Seeding completed. ${C.GREEN}${seedsApplied} new seeds applied.${C.RESET}`);
      await orm.close();
    } catch (error) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Seeding failed:`, error);
      if (orm) await orm.close();
      process.exit(1);
    }
  });

// --------------------------------------------------------------------------------------------------
// COMMAND: SEED:ROLLBACK (One step back)
// --------------------------------------------------------------------------------------------------

program
  .command("seed:rollback")
  .description("Rollback the most recently applied seed")
  .option(
    "-c, --config <path>",
    "Path to database config file",
    "config/database.ts",
  )
  .option(
    "-l, --log-level <level>",
    "Log level (error, warn, info, debug)",
    "info",
  )
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { config } = await loadConfig(options.config);
      orm = new Stabilize(config, { enabled: false, ttl: 60 }, { level: options.logLevel as LogLevel });

      const seedDir = path.resolve(process.cwd(), "seeds");
      const seedFiles = await glob(`${seedDir}/*.ts`);
      const seedGraph = new Map<
        string,
        { file: string; dependencies: string[] }
      >();
      for (const file of seedFiles) {
        const seedName = path.basename(file, ".ts");
        const seedModule = await import(file);
        seedGraph.set(seedName, {
          file,
          dependencies: seedModule.dependencies || [],
        });
      }

      const latestSeed = await orm["client"].query<{ name: string }>(
        `SELECT name FROM seed_history ORDER BY applied_at DESC LIMIT 1`,
      );

      if (latestSeed.length === 0) {
        console.log(`${C.YELLOW} WARNING ${C.RESET} No seeds to rollback.`);
        await orm.close();
        return;
      }

      const seedName = latestSeed[0]!.name;
      const seedFile = seedGraph.get(seedName)?.file;
      if (!seedFile) {
        console.error(`${C.BG_RED} ERROR ${C.RESET} Seed file for ${seedName} not found.`);
        await orm.close();
        return;
      }

      console.log(`${C.BLUE} INFO ${C.RESET} Rolling back seed: ${C.YELLOW}${seedName}${C.RESET}`);
      const seedModule = await import(seedFile);
      const rollbackFn = seedModule.rollback;
      
      if (typeof rollbackFn === "function") {
        await rollbackFn(orm);
        console.log(`${C.BG_GREEN} SUCCESS ${C.RESET} Rolled back seed: ${C.GREEN}${seedName}${C.RESET}`);
      } else {
        console.error(
          `${C.BG_RED} ERROR ${C.RESET} Seed file ${seedFile} must export a 'rollback' function.`,
        );
      }

      await orm.close();
    } catch (error) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Seed rollback failed:`, error);
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
  .option(
    "-c, --config <path>",
    "Path to database config file",
    "config/database.ts",
  )
  .option(
    "-l, --log-level <level>",
    "Log level (error, warn, info, debug)",
    "info",
  )
  .action(async (options) => {
    let orm: Stabilize | null = null;
    try {
      const { config } = await loadConfig(options.config);
      orm = new Stabilize(config, { enabled: false, ttl: 60 }, { level: options.logLevel as LogLevel });

      const migrationDir = path.resolve(process.cwd(), "migrations");
      const migrationFiles = await glob(`${migrationDir}/*.ts`);
      
      // Ensure migrations table exists for query purposes
      await orm["client"].query(`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      console.log(`\n${C.BRIGHT}Migration Status:${C.RESET}`);
      console.log(`---------------------------------`);
      for (const file of migrationFiles.sort()) {
        const migrationName = path.basename(file, ".ts");
        const applied = await orm["client"].query<{ name: string }>(
          `SELECT name FROM migrations WHERE name = ?`,
          [migrationName],
        );
        const status = applied.length > 0
          ? `${C.BG_GREEN} APPLIED ${C.RESET}`
          : `${C.BG_YELLOW} PENDING ${C.RESET}`;
          
        console.log(`${status} ${C.WHITE}${migrationName}${C.RESET}`);
      }

      // Ensure seed_history table exists for query purposes
      await orm["client"].query(`
        CREATE TABLE IF NOT EXISTS seed_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      
      const seedDir = path.resolve(process.cwd(), "seeds");
      const seedFiles = await glob(`${seedDir}/*.ts`);
      console.log(`\n${C.BRIGHT}Seed Status:${C.RESET}`);
      console.log(`---------------------------------`);
      for (const file of seedFiles.sort()) {
        const seedName = path.basename(file, ".ts");
        const applied = await orm["client"].query<{ name: string }>(
          `SELECT name FROM seed_history WHERE name = ?`,
          [seedName],
        );
        const status = applied.length > 0
          ? `${C.BG_GREEN} APPLIED ${C.RESET}`
          : `${C.BG_YELLOW} PENDING ${C.RESET}`;
          
        console.log(`${status} ${C.WHITE}${seedName}${C.RESET}`);
      }

      await orm.close();
    } catch (error) {
      console.error(`${C.BG_RED} FATAL ${C.RESET} Status check failed:`, error);
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
    if (temp.has(node))
      throw new Error(`Circular dependency detected at ${node}`);
    if (!visited.has(node)) {
      temp.add(node);
      const { dependencies } = graph.get(node)!;
      for (const dep of dependencies) {
        if (!graph.has(dep))
          throw new Error(`Dependency ${dep} not found for ${node}`);
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
