#!/usr/bin/env bun
/**
 * @file stabilize-cli.ts
 * @description The command-line interface for the Stabilize ORM.
 * @author ElectronSz
 */

import { program } from "commander";
import { generateMigration, runMigrations, Stabilize, defineModel, type Migration } from "../";
import { LogLevel, type DBConfig, type LoggerConfig, DBType } from "../";
import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";
import readline from "readline";
import { MetadataStorage } from "../model";
import { generateSeedData } from "./helper/generateSeedData";

const C = {
    RESET: "\x1b[0m", BRIGHT: "\x1b[1m", DIM: "\x1b[2m",
    RED: "\x1b[31m", GREEN: "\x1b[32m", YELLOW: "\x1b[33m", BLUE: "\x1b[34m",
    MAGENTA: "\x1b[35m", CYAN: "\x1b[36m", WHITE: "\x1b[37m",
    BG_GREEN: "\x1b[42m\x1b[30m", BG_RED: "\x1b[41m\x1b[37m", BG_YELLOW: "\x1b[43m\x1b[30m",
};

const version = "1.1.0";

const CLILogger = {
    info: (message: string) => console.log(`${C.BLUE}ℹ${C.RESET} ${message}`),
    success: (message: string) => console.log(`${C.GREEN}✔${C.RESET} ${C.GREEN}${message}${C.RESET}`),
    warn: (message: string) => console.log(`${C.YELLOW}⚠${C.RESET} ${message}`),
    error: (message: string, details?: string) => {
        console.error(`\n${C.BG_RED} ERROR ${C.RESET} ${C.RED}${message}${C.RESET}`);
        if (details) console.error(`${C.DIM}${details}${C.RESET}`);
        console.log();
    },
    panic: (error: Error, command: string) => {
        CLILogger.error(`A fatal error occurred in the '${command}' command.`, error.stack);
        process.exit(1);
    },
};

const spinner = {
    chars: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    interval: 80,
    _timer: null as NodeJS.Timeout | null,
    start: (message: string) => {
        let i = 0;
        process.stdout.write("\n");
        spinner._timer = setInterval(() => {
            process.stdout.write(`\r${C.CYAN}${spinner.chars[i++ % spinner.chars.length]}${C.RESET} ${message}`);
        }, spinner.interval);
    },
    stop: (success: boolean, message: string) => {
        if (spinner._timer) clearInterval(spinner._timer);
        process.stdout.write(`\r${success ? `${C.GREEN}✔` : `${C.RED}✖`} ${message}\n\n`);
    },
};

function displayBanner() {
    console.log(
        C.CYAN +
        "===== Stabilize CLI =====" +
        C.RESET
    );
    console.log(`  ${C.BRIGHT}Version:${C.RESET} ${C.YELLOW}${version}${C.RESET}`);
    console.log(`  ${C.BRIGHT}Developed by:${C.RESET} ${C.CYAN}ElectronSz${C.RESET}`);
    console.log(C.DIM + "----------------------------------------------------\n" + C.RESET);
}

async function loadConfig(configPath: string): Promise<{ config: DBConfig; orm: Stabilize }> {
    try {
        const absoluteConfigPath = path.resolve(process.cwd(), configPath);
        const configModule = await import(absoluteConfigPath);
        const config: DBConfig = configModule.dbConfig || configModule.default || configModule;
        const logLevelKey = program.opts().logLevel as keyof typeof LogLevel;
        const loggerConfig: LoggerConfig = { level: LogLevel[logLevelKey] };
        const orm = new Stabilize(config, { enabled: false, ttl: 60 }, loggerConfig);
        return { config, orm };
    } catch (error) {
        throw new Error(`Failed to load database configuration from '${configPath}'. Error: ${error}`);
    }
}

function formatQuery(query: string, dbType: string): string {
    if (dbType === DBType.Postgres) {
        let paramIndex = 0;
        return query.replace(/\?/g, () => `$${++paramIndex}`);
    }
    return query;
}

async function confirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${C.YELLOW}⚠${C.RESET} ${question} ${C.DIM}(y/N)${C.RESET} `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === "y");
        });
    });
}

if (process.argv.length <= 2 || process.argv.includes("--help") || process.argv.includes("-h")) {
    displayBanner();
}

// --------------------------------------------------------------------------------------------------
// COMMAND: GENERATE
// --------------------------------------------------------------------------------------------------
program
    .command("generate <type> <name> [fields...]")
    .description("Generate a new model, migration, or seed file.")
    .option("-n, --count <number>", "How many rows to generate", "2")
    .action(async (type: string, name: string, fields: string[] = [], options: { count: string }) => {
        const capitalizedName = name.charAt(0).toUpperCase() + name.slice(1);

        // Helper: parse CLI field definitions
        function parseFields(fieldArgs: string[]) {
            const columns: string[] = [];
            for (const arg of fieldArgs) {
                let [field, typeRaw] = arg.split(":");
                field = (field || "").trim();
                if (!field) continue;
                const type = (typeRaw || "string").toLowerCase();
                let prop;
                switch (type) {
                    case "int":
                    case "integer":
                        prop = `{ type: DataTypes.INTEGER }`;
                        break;
                    case "bool":
                    case "boolean":
                        prop = `{ type: DataTypes.BOOLEAN }`;
                        break;
                    case "date":
                        prop = `{ type: DataTypes.DATE }`;
                        break;
                    case "string":
                    default:
                        prop = `{ type: DataTypes.STRING }`;
                }
                columns.push(`    ${field}: ${prop},`);
            }
            return columns;
        }

        try {
            if (type === "migration") {
                const modelPath = path.resolve(process.cwd(), "models", `${name}.ts`);
                const { config } = await loadConfig("config/database.ts");
                const modelModule = await import(modelPath).catch(() => {
                    throw new Error(`Model file not found at '${modelPath}'.`);
                });
                const modelClass = modelModule[capitalizedName];
                if (!modelClass || !MetadataStorage.getModelMetadata(modelClass)) {
                    throw new Error(`Class '${capitalizedName}' in '${modelPath}' is not a valid model defined with defineModel.`);
                }
                const migration = await generateMigration(modelClass, `create_${name}_table`, config.type);
                const migrationDir = path.resolve(process.cwd(), "migrations");
                await fs.mkdir(migrationDir, { recursive: true });
                const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
                const fileName = `${timestamp}_create_${name}_table.json`;
                migration.name = path.basename(fileName, ".json");
                const filePath = path.join(migrationDir, fileName);
                await fs.writeFile(filePath, JSON.stringify(migration, null, 2));
                CLILogger.success(`Migration generated: ${filePath}`);
            } else if (type === "model") {
                const modelDir = path.resolve(process.cwd(), "models");
                await fs.mkdir(modelDir, { recursive: true });
                const filePath = path.join(modelDir, `${name}.ts`);

                // Parse user fields, always add id by default
                const userColumns = parseFields(fields).join("\n");
                const content = `
import { defineModel, DataTypes } from "stabilize-orm";

const ${capitalizedName} = defineModel({
  tableName: "${name.toLowerCase()}s",
  versioned: true,
  softDelete: true,
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
${userColumns}
  },
  timestamps: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  hooks: {
    afterCreate: (entity) => {
      console.log(\`${capitalizedName} created: \${entity.id}\`);
    },
    afterUpdate: async (entity) => {
     console.log(\`${capitalizedName} updated: \${entity.id}\`);
    },
  },
});

export { ${capitalizedName} };
`.trim() + "\n";
                await fs.writeFile(filePath, content);
                CLILogger.success(`Model generated: ${filePath}`);
            } else if (type === "seed") {
                const seedDir = path.resolve(process.cwd(), "seeds");
                await fs.mkdir(seedDir, { recursive: true });
                const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
                const fileName = `${timestamp}_${name}.ts`;
                const filePath = path.join(seedDir, fileName);

                // Load the model to inspect its schema
                const modelPath = path.resolve(process.cwd(), "models", `${name}.ts`);
                const { config } = await loadConfig("config/database.ts");
                const modelModule = await import(modelPath).catch(() => {
                    throw new Error(`Model file not found at '${modelPath}'.`);
                });
                const modelClass = modelModule[capitalizedName];
                if (!modelClass || !MetadataStorage.getModelMetadata(modelClass)) {
                    throw new Error(`Class '${capitalizedName}' in '${modelPath}' is not a valid model defined with defineModel.`);
                }

                // Use count option
                const count = Math.max(1, Number(options.count) || 2);

                // Generate seed data from model definition and db type
                const seedRows = generateSeedData(modelClass, config.type, count);

                const content = `
import { Stabilize } from "stabilize-orm";
import { ${capitalizedName} } from "../models/${name}";

export const dependencies: string[] = [];

export async function seed(orm: Stabilize): Promise<void> {
  const repo = orm.getRepository(${capitalizedName});
  await repo.bulkCreate(${JSON.stringify(seedRows, null, 2)});
}

export async function rollback(orm: Stabilize): Promise<void> {
  ${seedRows
                        .map(
                            (row) =>
                                `await orm.client.query(\`DELETE FROM ${name.toLowerCase()}s WHERE id = ?\`, [${row.id}]);`
                        )
                        .join("\n  ")}
}
`.trim() + "\n";

                await fs.writeFile(filePath, content);
                CLILogger.success(`Seed generated: ${filePath}`);
            } else {
                CLILogger.error(`Invalid type '${type}'. Use 'model', 'migration', or 'seed'.`);
            }
        } catch (error) {
            CLILogger.panic(error as Error, "generate");
        }
    });

// --------------------------------------------------------------------------------------------------
// COMMANDS: MIGRATE & ROLLBACK
// --------------------------------------------------------------------------------------------------
program
    .command("migrate")
    .description("Apply all pending database migrations.")
    .option("-c, --config <path>", "Path to database config file", "config/database.ts")
    .action(async (options) => {
        let orm: Stabilize | null = null;
        try {
            const { orm: loadedOrm, config } = await loadConfig(options.config);
            orm = loadedOrm;
            const migrationDir = path.resolve(process.cwd(), "migrations");
            const migrationFiles = (await glob(`${migrationDir}/*.json`)).sort();
            const migrations: Migration[] = await Promise.all(
                migrationFiles.map(async (file) => JSON.parse(await fs.readFile(file, "utf-8")))
            );
            if (migrations.length === 0) {
                CLILogger.warn("No migration files found.");
                return;
            }
            spinner.start("Applying migrations...");
            await runMigrations(config, migrations);
            spinner.stop(true, "All pending migrations applied.");
        } catch (error) {
            spinner.stop(false, "Migration process failed.");
            CLILogger.panic(error as Error, "migrate");
        } finally {
            // Always reset terminal color/style on exit!
            process.stdout.write('\x1b[0m');
            if (orm) await orm.close();
        }
    });

program
    .command("migrate:rollback")
    .description("Roll back the most recently applied migration.")
    .option("-c, --config <path>", "Path to database config file", "config/database.ts")
    .action(async (options) => {
        let orm: Stabilize | null = null;
        try {
            const { orm: loadedOrm } = await loadConfig(options.config);
            orm = loadedOrm;
            spinner.start("Rolling back last migration...");
            const [latest] = await orm.client.query<{ name: string }>(
                `SELECT name FROM stabilize_migrations ORDER BY applied_at DESC, name DESC LIMIT 1`
            );
            if (!latest) {
                spinner.stop(false, "No migrations to roll back.");
                return;
            }
            const migrationFile = path.resolve(process.cwd(), "migrations", `${latest.name}.json`);
            const migration: Migration = JSON.parse(await fs.readFile(migrationFile, "utf-8"));
            await orm.transaction(async (txClient) => {
                for (const query of migration.down) await txClient.query(query);
                await txClient.query(`DELETE FROM stabilize_migrations WHERE name = ?`, [latest.name]);
            });
            spinner.stop(true, `Rolled back: ${latest.name}`);
        } catch (error) {
            spinner.stop(false, "Rollback failed.");
            CLILogger.panic(error as Error, "migrate:rollback");
        } finally {
            // Always reset terminal color/style on exit!
            process.stdout.write('\x1b[0m');
            if (orm) await orm.close();
        }
    });

// --------------------------------------------------------------------------------------------------
// COMMANDS: SEED & ROLLBACK
// --------------------------------------------------------------------------------------------------
program
    .command("seed")
    .description("Run all pending seed files.")
    .option("-c, --config <path>", "Path to db config file", "config/database.ts")
    .action(async (options) => {
        let orm: Stabilize | null = null;
        try {
            const { orm: loadedOrm } = await loadConfig(options.config);
            orm = loadedOrm;
            const dbType = orm.client.config.type;
            let seedTableSQL: string;
            if (dbType === DBType.MySQL) {
                seedTableSQL = `CREATE TABLE IF NOT EXISTS stabilize_seed_history (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    applied_at DATETIME NOT NULL
                )`;
            } else if (dbType === DBType.Postgres) {
                seedTableSQL = `CREATE TABLE IF NOT EXISTS stabilize_seed_history (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    applied_at TIMESTAMP WITH TIME ZONE NOT NULL
                )`;
            } else {
                seedTableSQL = `CREATE TABLE IF NOT EXISTS stabilize_seed_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                )`;
            }
            await orm.client.query(seedTableSQL);

            const seedDir = path.resolve(process.cwd(), "seeds");
            const seedFiles = await glob(`${seedDir}/*.ts`);
            const graph = new Map<string, { file: string; dependencies: string[] }>();
            function toImportPath(file: string) {
                return path.resolve(file).replace(/\\/g, "/");
            }
            for (const file of seedFiles) {
                const name = path.basename(file, ".ts");
                const mod = await import(toImportPath(file));
                graph.set(name, { file, dependencies: mod.dependencies || [] });
            }
            const orderedSeeds = topologicalSort(graph);
            const appliedSeeds = new Set(
                (await orm.client.query<{ name: string }>(`SELECT name FROM stabilize_seed_history`)).map((r) => r.name)
            );
            const pendingSeeds = orderedSeeds.filter((s) => !appliedSeeds.has(s));
            if (pendingSeeds.length === 0) {
                CLILogger.warn("No pending seeds to run.");
                // Always reset terminal color/style on early return!
                process.stdout.write('\x1b[0m');
                return;
            }
            spinner.start(`Running ${pendingSeeds.length} seed(s)...`);
            for (const seedName of pendingSeeds) {
                const mod = await import(toImportPath(graph.get(seedName)!.file));
                await orm.transaction(async (txClient) => {
                    const originalClient = orm!.client;
                    orm!.client = txClient;
                    await mod.seed(orm);
                    orm!.client = originalClient;
                    const dbType = txClient.config.type;
                    const insertQuery = formatQuery(
                        `INSERT INTO stabilize_seed_history (name, applied_at) VALUES (?, ?)`,
                        dbType
                    );
                    let appliedAt: string;
                    if (dbType === DBType.MySQL) {
                        appliedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
                    } else {
                        appliedAt = new Date().toISOString();
                    }
                    await txClient.query(insertQuery, [seedName, appliedAt]);
                });
            }
            spinner.stop(true, `Successfully applied ${pendingSeeds.length} seed(s).`);
        } catch (error) {
            spinner.stop(false, `Seeding process failed. Error: ${error}`);
            CLILogger.panic(error as Error, "seed");
        } finally {
            // Always reset terminal color/style on exit!
            process.stdout.write('\x1b[0m');
            if (orm) await orm.close();
        }
    });


program
    .command("seed:rollback")
    .description("Roll back the most recently applied seed.")
    .option("-c, --config <path>", "Path to db config file", "config/database.ts")
    .action(async (options) => {
        let orm: Stabilize | null = null;
        try {
            const { orm: loadedOrm } = await loadConfig(options.config);
            orm = loadedOrm;
            spinner.start("Rolling back last seed...");
            const [latest] = await orm.client.query<{ name: string }>(
                `SELECT name FROM stabilize_seed_history ORDER BY applied_at DESC, name DESC LIMIT 1`
            );
            if (!latest) {
                spinner.stop(false, "No seeds to roll back.");
                return;
            }
            const seedFile = path.resolve(process.cwd(), "seeds", `${latest.name}.ts`);
            const mod = await import(toImportPath(seedFile));
            if (typeof mod.rollback !== "function") {
                throw new Error(`Rollback function not found in '${latest.name}.ts'`);
            }
            await orm.transaction(async (txClient) => {
                const txOrm = new Stabilize(orm!.client.config, { enabled: false, ttl: 60 }, { level: LogLevel.Error });
                (txOrm as any).client = txClient; // Use the transactional client
                await mod.rollback(txOrm);
                await txClient.query(`DELETE FROM stabilize_seed_history WHERE name = ?`, [latest.name]);
            });
            spinner.stop(true, `Rolled back seed: ${latest.name}`);
        } catch (error) {
            spinner.stop(false, "Seed rollback failed.");
            CLILogger.panic(error as Error, "seed:rollback");
        } finally {
            // Always reset terminal color/style on exit!
            process.stdout.write('\x1b[0m');
            if (orm) await orm.close();
        }
    });

// --------------------------------------------------------------------------------------------------
// COMMANDS: DB & STATUS
// --------------------------------------------------------------------------------------------------
program
    .command("db:drop")
    .description("Drop all tables in the database. USE WITH CAUTION. Does NOT drop the database itself.")
    .option("-c, --config <path>", "Path to db config file", "config/database.ts")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (options) => {
        let orm: Stabilize | null = null;
        try {
            const { orm: loadedOrm, config } = await loadConfig(options.config);
            orm = loadedOrm;

            let dbName: string;
            if (config.type === DBType.SQLite) {
                dbName = config.connectionString;
            } else {
                const url = new URL(config.connectionString);
                dbName = url.pathname.substring(1);
            }

            if (!options.force && !(await confirm(`This will permanently delete ALL TABLES in the '${dbName}' database. Are you sure?`))) {
                CLILogger.warn("Table drop cancelled.");
                return;
            }

            spinner.start(`Dropping all tables in database '${dbName}'...`);

            if (config.type === DBType.SQLite) {
                await orm.close();
                await new Promise((r) => setTimeout(r, 5000)); // Allow SQLite to release file lock
                const absPath = path.isAbsolute(dbName) ? dbName : path.resolve(process.cwd(), dbName);
                CLILogger.info(`Attempting to delete SQLite database file: ${absPath}`);
                try {
                    await fs.unlink(absPath);
                    CLILogger.success(`Successfully deleted SQLite database: ${absPath}`);
                } catch (err) {
                    CLILogger.warn(`Failed to delete SQLite database '${absPath}': ${err}`);
                }
            } else if (config.type === DBType.Postgres) {
                const tables = await orm.client.query<{ tablename: string }>(
                    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
                );
                for (const { tablename } of tables) {
                    await orm.client.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
                }
            } else if (config.type === DBType.MySQL) {
                const tables = await orm.client.query<{ table_name: string }>(
                    `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`
                );
                for (const { table_name } of tables) {
                    await orm.client.query(`DROP TABLE IF EXISTS \`${table_name}\``);
                }
            }
            spinner.stop(true, `All tables dropped successfully from database '${dbName}'.`);
        } catch (error) {
            spinner.stop(false, "Failed to drop tables.");
            CLILogger.panic(error as Error, "db:drop");
        } finally {
            // Always reset terminal color/style on exit!
            process.stdout.write('\x1b[0m');
            if (orm) await orm.close();
        }
    });

program
    .command("db:reset")
    .description("Drop, create, migrate, and seed the database.")
    .option("-c, --config <path>", "Path to db config file", "config/database.ts")
    .option("-f, --force", "Skip confirmation prompt for db:drop")
    .action(async (options) => {
        CLILogger.warn("This command will destroy and rebuild your database.");
        try {
            await program.commands
                .find((c) => c.name() === "db:drop")
                ?.parseAsync([...process.argv, ...(options.force ? ["--force"] : [])], { from: "user" });
            CLILogger.info("Creating database... (Handled automatically by the driver on first connection)");
            await program.commands.find((c) => c.name() === "migrate")?.parseAsync(process.argv, { from: "user" });
            await program.commands.find((c) => c.name() === "seed")?.parseAsync(process.argv, { from: "user" });
            CLILogger.success("Database reset complete.");
        } catch (error) {
            CLILogger.panic(error as Error, "db:reset");
        }
    });

program
    .command("status")
    .description("Show the status of all migrations and seeds.")
    .option("-c, --config <path>", "Path to db config file", "config/database.ts")
    .action(async (options) => {
        let orm: Stabilize | null = null;
        try {
            const { orm: loadedOrm } = await loadConfig(options.config);
            orm = loadedOrm;

            console.log(`\n${C.BRIGHT}Migration Status${C.RESET}`);
            console.log(`---------------------------------`);
            const migrationFiles = (await glob(`migrations/*.json`)).map((f) => path.basename(f, ".json")).sort();
            const appliedMigrations = new Set(
                (await orm.client.query<{ name: string }>(`SELECT name FROM stabilize_migrations`)).map((r) => r.name)
            );
            migrationFiles.forEach((name) => {
                const status = appliedMigrations.has(name) ? `${C.BG_GREEN} APPLIED ${C.RESET}` : `${C.BG_YELLOW} PENDING ${C.RESET}`;
                console.log(`${status} ${C.WHITE}${name}${C.RESET}`);
            });
            if (migrationFiles.length === 0) console.log(C.DIM + "  No migration files found." + C.RESET);

            console.log(`\n${C.BRIGHT}Seed Status${C.RESET}`);
            console.log(`---------------------------------`);
            const seedFiles = (await glob(`seeds/*.ts`)).map((f) => path.basename(f, ".ts")).sort();
            const appliedSeeds = new Set(
                (await orm.client.query<{ name: string }>(`SELECT name FROM stabilize_seed_history`)).map((r) => r.name)
            );
            seedFiles.forEach((name) => {
                const status = appliedSeeds.has(name) ? `${C.BG_GREEN} APPLIED ${C.RESET}` : `${C.BG_YELLOW} PENDING ${C.RESET}`;
                console.log(`${status} ${C.WHITE}${name}${C.RESET}`);
            });
            if (seedFiles.length === 0) console.log(C.DIM + "  No seed files found." + C.RESET);
            console.log();
        } catch (error) {
            CLILogger.panic(error as Error, "status");
        } finally {
            // Always reset terminal color/style on exit!
            process.stdout.write('\x1b[0m');
            if (orm) await orm.close();
        }
    });

// --------------------------------------------------------------------------------------------------
// TOPOLOGICAL SORT HELPER for seeding
// --------------------------------------------------------------------------------------------------
function topologicalSort(graph: Map<string, { file: string; dependencies: string[] }>): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();
    function visit(node: string) {
        if (temp.has(node)) throw new Error(`Circular dependency detected: ${node}`);
        if (!visited.has(node)) {
            temp.add(node);
            const deps = graph.get(node)?.dependencies || [];
            for (const dep of deps) {
                if (!graph.has(dep)) throw new Error(`Dependency '${dep}' not found for seed '${node}'`);
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

function toImportPath(file: string) {
    return path.resolve(file).replace(/\\/g, "/");
}

program
    .option("-l, --log-level <level>", "Global log level", "Info")
    .parse(process.argv);