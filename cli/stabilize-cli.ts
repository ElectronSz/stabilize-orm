#!/usr/bin/env bun
import { program } from 'commander';
import { generateMigration, Stabilize, DBType, type DBConfig, LogLevel, type LoggerConfig } from '../src';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

program
  .version('1.0.5')
  .description('Stabilize ORM CLI');

program
  .command('generate <type> <name>')
  .description('Generate a model, migration, or seed')
  .option('-l, --log-level <level>', 'Log level (error, warn, info, debug)', 'info')
  .action(async (type: string, name: string, options) => {
    const loggerConfig: LoggerConfig = {
      level: options.logLevel as LogLevel,
      filePath: path.resolve(process.cwd(), 'logs/stabilize.log'),
      maxFileSize: 5 * 1024 * 1024,
      maxFiles: 3,
    };

    if (type === 'migration') {
      const modelPath = path.resolve(process.cwd(), 'models', `${name}.ts`);
      try {
        const modelModule = await import(modelPath);
        const model = Object.values(modelModule)[0] as new (...args: any[]) => any;
        const migration = await generateMigration(model, `create_${name.toLowerCase()}`);
        const migrationDir = path.resolve(process.cwd(), 'migrations');
        await fs.mkdir(migrationDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[-:T.]/g, '');
        const migrationFile = path.join(migrationDir, `${timestamp}_${name.toLowerCase()}.ts`);
        await fs.writeFile(migrationFile, `export default ${JSON.stringify(migration, null, 2)};`);
        console.log(`Migration generated: ${migrationFile}`);
      } catch (error) {
        console.error('Error generating migration:', error);
      }
    } else if (type === 'model') {
      const modelDir = path.resolve(process.cwd(), 'models');
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
      console.log(`Model generated: ${modelFile}`);
    } else if (type === 'seed') {
      const seedDir = path.resolve(process.cwd(), 'seeds');
      await fs.mkdir(seedDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[-:T.]/g, '');
      const seedFile = path.join(seedDir, `${timestamp}_${name.toLowerCase()}.ts`);
      const seedContent = `
import { Stabilize } from 'stabilize-orm';

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
  const entities = await repo.find().execute(orm['client']);
  await repo.bulkDelete(entities.map(e => e.id!), { batchSize: 100 });

  await orm['client'].query(
    \`DELETE FROM seed_history WHERE name = ?\`,
    ['${timestamp}_${name.toLowerCase()}']
  );
}
`;
      await fs.writeFile(seedFile, seedContent);
      console.log(`Seed generated: ${seedFile}`);
    } else {
      console.error('Invalid type. Use "model", "migration", or "seed".');
    }
  });

program
  .command('seed')
  .description('Run seed files to populate the database')
  .option('-c, --config <path>', 'Path to database config file', 'config/database.ts')
  .option('-l, --log-level <level>', 'Log level (error, warn, info, debug)', 'info')
  .action(async (options) => {
    try {
      const configPath = path.resolve(process.cwd(), options.config);
      const configModule = await import(configPath);
      const config: DBConfig = configModule.default || configModule;

      const loggerConfig: LoggerConfig = {
        level: options.logLevel as LogLevel,
        filePath: path.resolve(process.cwd(), 'logs/stabilize.log'),
        maxFileSize: 5 * 1024 * 1024,
        maxFiles: 3,
      };

      const orm = new Stabilize(config, { enabled: false, ttl: 60 }, loggerConfig);

      await orm['client'].query(`
        CREATE TABLE IF NOT EXISTS seed_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      const seedDir = path.resolve(process.cwd(), 'seeds');
      const seedFiles = await glob(`${seedDir}/*.ts`);
      if (seedFiles.length === 0) {
        console.log('No seed files found in seeds/ directory.');
        await orm.close();
        return;
      }

      const seedGraph = new Map<string, { file: string; dependencies: string[] }>();
      for (const file of seedFiles) {
        const seedName = path.basename(file, '.ts');
        const seedModule = await import(file);
        seedGraph.set(seedName, { file, dependencies: seedModule.dependencies || [] });
      }

      const orderedSeeds = topologicalSort(seedGraph);

      console.log(`Running ${orderedSeeds.length} seed files...`);
      for (const seedName of orderedSeeds) {
        const { file } = seedGraph.get(seedName)!;
        const applied = await orm['client'].query<{ id: number }>(
          `SELECT id FROM seed_history WHERE name = ?`,
          [seedName]
        );
        if (applied.length > 0) {
          console.log(`Skipping already applied seed: ${seedName}`);
          continue;
        }

        console.log(`Executing seed: ${seedName}`);
        const seedModule = await import(file);
        const seedFn = seedModule.default || seedModule.seed;
        if (typeof seedFn === 'function') {
          await seedFn(orm);
        } else {
          console.error(`Seed file ${file} must export a default function or a function named 'seed'.`);
        }
      }

      console.log('Seeding completed successfully.');
      await orm.close();
    } catch (error) {
      console.error('Seeding failed:', error);
      process.exit(1);
    }
  });

program
  .command('seed:rollback')
  .description('Rollback the most recently applied seed')
  .option('-c, --config <path>', 'Path to database config file', 'config/database.ts')
  .option('-l, --log-level <level>', 'Log level (error, warn, info, debug)', 'info')
  .action(async (options) => {
    try {
      const configPath = path.resolve(process.cwd(), options.config);
      const configModule = await import(configPath);
      const config: DBConfig = configModule.default || configModule;

      const loggerConfig: LoggerConfig = {
        level: options.logLevel as LogLevel,
        filePath: path.resolve(process.cwd(), 'logs/stabilize.log'),
        maxFileSize: 5 * 1024 * 1024,
        maxFiles: 3,
      };

      const orm = new Stabilize(config, { enabled: false, ttl: 60 }, loggerConfig);

      const seedDir = path.resolve(process.cwd(), 'seeds');
      const seedFiles = await glob(`${seedDir}/*.ts`);
      const seedGraph = new Map<string, { file: string; dependencies: string[] }>();
      for (const file of seedFiles) {
        const seedName = path.basename(file, '.ts');
        const seedModule = await import(file);
        seedGraph.set(seedName, { file, dependencies: seedModule.dependencies || [] });
      }

      const latestSeed = await orm['client'].query<{ name: string }>(
        `SELECT name FROM seed_history ORDER BY applied_at DESC LIMIT 1`
      );

      if (latestSeed.length === 0) {
        console.log('No seeds to rollback.');
        await orm.close();
        return;
      }

      const seedName = latestSeed[0]!.name;
      const seedFile = seedGraph.get(seedName)?.file;
      if (!seedFile) {
        console.error(`Seed file for ${seedName} not found.`);
        await orm.close();
        return;
      }

      console.log(`Rolling back seed: ${seedName}`);
      const seedModule = await import(seedFile);
      const rollbackFn = seedModule.rollback;
      if (typeof rollbackFn === 'function') {
        await rollbackFn(orm);
        console.log(`Rolled back seed: ${seedName}`);
      } else {
        console.error(`Seed file ${seedFile} must export a 'rollback' function.`);
      }

      await orm.close();
    } catch (error) {
      console.error('Seed rollback failed:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Display status of migrations and seeds')
  .option('-c, --config <path>', 'Path to database config file', 'config/database.ts')
  .option('-l, --log-level <level>', 'Log level (error, warn, info, debug)', 'info')
  .action(async (options) => {
    try {
      const configPath = path.resolve(process.cwd(), options.config);
      const configModule = await import(configPath);
      const config: DBConfig = configModule.default || configModule;

      const loggerConfig: LoggerConfig = {
        level: options.logLevel as LogLevel,
        filePath: path.resolve(process.cwd(), 'logs/stabilize.log'),
        maxFileSize: 1 * 1024 * 1024,
        maxFiles: 3,
      };

      const orm = new Stabilize(config, { enabled: false, ttl: 60 }, loggerConfig);

      const migrationDir = path.resolve(process.cwd(), 'migrations');
      const migrationFiles = await glob(`${migrationDir}/*.ts`);
      console.log('\nMigration Status:');
      console.log('-----------------');
      for (const file of migrationFiles.sort()) {
        const migrationName = path.basename(file, '.ts');
        const applied = await orm['client'].query(
          `SELECT name FROM migrations WHERE name = ?`,
          [migrationName]
        );
        console.log(`${migrationName}: ${applied.length > 0 ? 'Applied' : 'Pending'}`);
      }

      const seedDir = path.resolve(process.cwd(), 'seeds');
      const seedFiles = await glob(`${seedDir}/*.ts`);
      console.log('\nSeed Status:');
      console.log('-------------');
      for (const file of seedFiles.sort()) {
        const seedName = path.basename(file, '.ts');
        const applied = await orm['client'].query(
          `SELECT name FROM seed_history WHERE name = ?`,
          [seedName]
        );
        console.log(`${seedName}: ${applied.length > 0 ? 'Applied' : 'Pending'}`);
      }

      await orm.close();
    } catch (error) {
      console.error('Status check failed:', error);
      process.exit(1);
    }
  });

function topologicalSort(graph: Map<string, { file: string; dependencies: string[] }>): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const temp = new Set<string>();

  function visit(node: string) {
    if (temp.has(node)) throw new Error(`Circular dependency detected at ${node}`);
    if (!visited.has(node)) {
      temp.add(node);
      const { dependencies } = graph.get(node)!;
      for (const dep of dependencies) {
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