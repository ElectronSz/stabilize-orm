/**
 * @file mongo-migrate.ts
 * @description Runs and generates MongoDB migrations.
 * @author ElectronSz
 *
 * Mirrors `runMigrations` step for step, with one divergence that has a reason:
 * **the steps of a migration are not wrapped in a transaction.** `createIndex`
 * is not permitted inside one, and DDL is not transactional in MongoDB at all,
 * so a transaction here would either fail on the first index or give a false
 * impression of atomicity.
 *
 * The consequence is stated rather than hidden: a migration that fails halfway
 * leaves a partially migrated collection and **no ledger entry**, so re-running
 * applies it again from the start. That is the same failure mode MySQL's
 * auto-committing DDL already has on the SQL side, and the alternative — a
 * rollback that cannot exist — would be a lie.
 */

import { MetadataStorage } from "./model";
import { DBClient } from "./client";
import { StabilizeError, type DBConfig, type Migration, type StabilizeEmitter } from "./types";
import {
  generateMongoSteps,
  modelUsesGeneratedIds,
  mongoCollectionName,
  type MongoStep,
} from "./mongo-schema";

/**
 * The collection the migration ledger lives in.
 *
 * No counter: a migration is identified by name, and the name is the `_id`, so
 * uniqueness is enforced by the storage layer rather than by a read first.
 */
export const MONGO_MIGRATIONS_COLLECTION = "stabilize_migrations";

/**
 * Runs the steps of one migration.
 *
 * Sequential, and deliberately not transactional. @see the note at the top of
 * this file.
 *
 * @param db The client to run through.
 * @param steps The steps to apply, in order.
 */
async function runSteps(db: DBClient, steps: MongoStep[]): Promise<void> {
  for (const step of steps) {
    switch (step.kind) {
      case "createCollection": {
        // `create` on a collection that exists is a `NamespaceExists` error, and
        // a migration that was interrupted just after creating a collection is
        // the ordinary case. Asked for first rather than caught, so that a
        // genuinely unexpected failure is not swallowed along with it.
        const existing = await db.mongoListCollections();
        if (existing.some((entry: any) => entry?.name === step.collection)) {
          break;
        }
        await db.mongoCommand({
          create: step.collection,
          ...(step.validator ? { validator: step.validator } : {}),
          validationLevel: "moderate",
          validationAction: "error",
        });
        break;
      }

      case "createIndex":
        await db.mongoCreateIndex(step.collection, step.spec, step.options ?? {});
        break;

      case "dropIndex":
        await db.mongoCommand({
          dropIndexes: step.collection,
          index: step.name,
        });
        break;

      case "collMod":
        await db.mongoCommand({
          collMod: step.collection,
          validator: step.validator,
          validationLevel: "moderate",
        });
        break;

      case "dropCollection":
        // `drop` on a missing collection is a `NamespaceNotFound` error. The
        // collection not being there is the state a drop is asking for, so it
        // is not a failure.
        await db.mongoCommand({ drop: step.collection }).catch(() => {});
        break;

      case "createCounter":
        await db.mongoUpdateOne(
          "stabilize_counters",
          { _id: step.collection },
          { $setOnInsert: { seq: 0 } },
          { upsert: true },
        );
        break;

      default: {
        const unknown = step as { kind: string };
        throw new StabilizeError(
          `Unknown MongoDB migration step '${unknown.kind}'.`,
          "MIGRATE_ERROR",
        );
      }
    }
  }
}

/**
 * Builds a migration for a model, in the shape the SQL migrations already use.
 *
 * `up` and `down` are empty on purpose: they are SQL, and there is no SQL here.
 * The Mongo half rides in `mongoUp`/`mongoDown`, which `tests/migrations.test.ts`
 * never sees and `runMigrations` never reads.
 *
 * @param model The model to generate for.
 * @param name The migration's name, and its identity in the ledger.
 */
export function generateMongoMigration(
  model: any,
  name: string,
): Migration {
  const meta = MetadataStorage.getModelMetadata(model);
  if (!meta?.tableName) {
    throw new StabilizeError(
      `Model is missing tableName. Use defineModel() or add static schema.`,
      "MIGRATE_ERROR",
    );
  }

  return {
    name,
    up: [],
    down: [],
    mongoUp: buildUpSteps(model),
    // Derived, not hand-written, so the inverse of a migration is the inverse of
    // exactly what it created — a versioned model's history collection included.
    mongoDown: generateMongoSteps(model, "down"),
  };
}

/**
 * The steps that bring a model's collection into existence.
 *
 * Adds the counter step on top of what `generateMongoSteps` derives: the
 * collection plan describes the collection, and the counter lives in a different
 * one, so it is not something a per-collection plan can express.
 *
 * @param model The model to build for.
 */
function buildUpSteps(model: any): MongoStep[] {
  const steps = generateMongoSteps(model, "up");
  if (steps.length === 0) return steps;

  if (modelUsesGeneratedIds(model)) {
    const collection = mongoCollectionName(model);
    if (collection) steps.push({ kind: "createCounter", collection });
  }
  return steps;
}

/**
 * Reverses one applied migration and removes its ledger entry.
 *
 * The SQL path wraps `down` in a transaction. This one cannot, for the reason at
 * the top of this file — `dropIndexes` and `collMod` are not permitted inside
 * one. Steps run in order and the ledger entry is deleted only after every one
 * of them succeeded, so a partial rollback leaves the entry in place and
 * re-running picks up where it stopped rather than skipping the remainder.
 *
 * @param config The database configuration.
 * @param name The migration's name, as recorded in the ledger.
 * @param migration The migration to reverse; only its `mongoDown` is read.
 */
export async function rollbackMongoMigration(
  config: DBConfig,
  name: string,
  migration: Migration,
): Promise<void> {
  const client = new DBClient(config);
  try {
    await runSteps(client, migration.mongoDown ?? []);
    await client.mongoDeleteOne(MONGO_MIGRATIONS_COLLECTION, { _id: name });
  } finally {
    await client.close();
  }
}

/**
 * Applies every pending migration, recording each in the ledger.
 *
 * Fires `migration:start` and `migration:complete` once per migration actually
 * applied, matching the SQL runner step for step.
 *
 * @param config The database configuration.
 * @param migrations The migrations to apply, in order.
 * @param events Optional emitter to report on. `Stabilize.migrate` passes the
 *   ORM's own, which is what puts migrations on the same event stream as
 *   ordinary queries; called directly, the run is unreported.
 */
export async function runMongoMigrations(
  config: DBConfig,
  migrations: Migration[],
  events?: StabilizeEmitter,
): Promise<void> {
  const client = new DBClient(config, undefined, null, null, events);
  try {
    for (const [index, migration] of migrations.entries()) {
      const name =
        migration.name || `migration_${index}_${new Date().getTime()}`;

      const applied = await client.mongoFindOne(MONGO_MIGRATIONS_COLLECTION, {
        _id: name,
      });
      if (applied) continue;

      console.log(`Applying migration: ${name}...`);
      const steps: MongoStep[] = migration.mongoUp ?? [];

      // A migration that carries only SQL has nothing to do here. Saying so is
      // better than reporting success for work that never happened.
      if (steps.length === 0 && migration.up.length > 0) {
        throw new StabilizeError(
          `Migration '${name}' contains SQL but no MongoDB steps. ` +
            `Generate it with generateMongoMigration() for a MongoDB target.`,
          "MIGRATE_ERROR",
        );
      }

      events?.emit("migration:start", {
        dbType: config.type,
        name,
        index,
        total: migrations.length,
      });

      // Sequentially, and not in a transaction. @see the note at the top.
      await runSteps(client, steps);

      // Recorded only after every step succeeded, so an interrupted migration
      // is retried rather than skipped.
      await client.mongoInsertOne(MONGO_MIGRATIONS_COLLECTION, {
        _id: name,
        applied_at: new Date(),
      });

      console.log(`Migration ${name} applied successfully.`);
      events?.emit("migration:complete", {
        dbType: config.type,
        name,
        index,
        total: migrations.length,
      });
    }
  } catch (error) {
    events?.emit("error", { dbType: config.type, phase: "migration", error });
    throw error;
  } finally {
    await client.close();
  }
}
