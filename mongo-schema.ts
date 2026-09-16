/**
 * @file mongo-schema.ts
 * @description Derives MongoDB collections, indexes and validators from a model.
 * @author ElectronSz
 *
 * A fourth type mapper rather than a branch inside the three the SQL side
 * already has. The three agree on a shape — a type name goes in, a SQL type name
 * comes out — and a BSON schema is not that: it is a document, it carries the
 * validators the model already declares, and two of its rules (`INTEGER` spans
 * several BSON types, an encrypted column is always a string) are properties no
 * SQL dialect has. Folding it in would have made the SQL mappers harder to read
 * for no SQL benefit.
 *
 * Two rules here are load-bearing, and both exist so that `autoMigrate` cannot
 * break data it has already written:
 *
 *   1. `validationLevel: "moderate"` on every validator. Under the default
 *      `"strict"`, an update to a document that lacks a newly declared required
 *      field is *rejected* — so `repo.update()` would fail on exactly the rows
 *      the migration just declared a field for.
 *   2. `sparse: true` on every unique index. MongoDB treats two documents that
 *      both lack the field as both null, so they collide; SQL treats two NULLs
 *      as distinct. Without `sparse`, `email: { unique: true }` would reject the
 *      second document that simply omits `email`.
 */

import { DBClient } from "./client";
import { MetadataStorage, type ColumnConfig } from "./model";
import {
  DataTypes,
  RelationType,
  StabilizeError,
  type MongoStep,
} from "./types";
import { MONGO_COUNTERS_COLLECTION } from "./mongo-repository";

/** Re-exported so schema callers do not have to reach into `types` for it. */
export type { MongoStep };

/**
 * Maps a declared column type onto a BSON schema.
 *
 * `INTEGER` accepts three BSON types, not one: a JavaScript integer becomes an
 * `int` inside 32-bit range and a `double` beyond it, so accepting only `"int"`
 * would reject every id past two billion. `BIGINT` is deliberately absent for
 * the same reason in reverse — a driver cannot tell the caller's `1` was meant
 * to be a 64-bit value.
 *
 * An encrypted column is a string whatever it was declared as, because the
 * ciphertext is what is stored. Validating it against its declared type would
 * reject every write.
 *
 * @param column The column to map.
 * @returns The `bsonType` (or `bsonType` list) for the column's schema.
 */
export function mapColumnToBsonSchema(
  column: ColumnConfig,
): Record<string, any> {
  const declared =
    typeof column.type === "string" ? column.type : DataTypes[column.type];
  const type = String(declared).toUpperCase();

  const schema: Record<string, any> = {};

  if (column.encrypted) {
    // Ciphertext, always. See above.
    schema.bsonType = "string";
  } else {
    switch (type) {
      case "INTEGER":
        schema.bsonType = ["int", "long", "double"];
        break;
      case "BIGINT":
        schema.bsonType = ["int", "long", "double"];
        break;
      case "FLOAT":
      case "DOUBLE":
      case "DECIMAL":
        // MongoDB has no exact decimal unless the caller passes a `Decimal128`.
        // A `DECIMAL` column is therefore a double, and a validator that
        // demanded exactness would reject everything the ORM writes.
        schema.bsonType = ["double", "int", "long", "decimal"];
        break;
      case "BOOLEAN":
        schema.bsonType = "bool";
        break;
      case "DATE":
      case "DATETIME":
        // A native date, never a string. A string fails this and also defeats
        // every range query that could have used an index.
        schema.bsonType = ["date", "string"];
        break;
      case "JSON":
        schema.bsonType = ["object", "array", "string"];
        break;
      case "BLOB":
        schema.bsonType = ["binData", "string"];
        break;
      case "UUID":
      case "STRING":
      case "TEXT":
      default:
        schema.bsonType = "string";
        break;
    }
  }

  // The model's own validators, promoted to server-enforced ones. This is a
  // free win: the same rules that `collectValidationErrors` checks in process
  // are then checked by the server as well, so a writer that bypasses the ORM
  // cannot store a value the model says is invalid.
  if (typeof column.minLength === "number") schema.minLength = column.minLength;
  if (typeof column.maxLength === "number") schema.maxLength = column.maxLength;
  if (typeof column.length === "number" && typeof column.minLength !== "number") {
    schema.maxLength = column.length;
  }
  if (column.pattern) {
    // A `RegExp` does not survive a round trip through an aggregation; its
    // source does.
    schema.pattern = column.pattern.source;
  }

  return schema;
}

/**
 * Builds the `$jsonSchema` validator for a model.
 *
 * `additionalProperties` is deliberately **not** `false`. A collection that
 * rejects undeclared fields stops being schemaless, which is the one property
 * that makes a document store worth using alongside the four SQL backends — and
 * it would make `autoMigrate` a one-way door, because a field written before it
 * was declared could never be written again.
 *
 * `required` includes the primary key: `_id` is the key the collection is
 * indexed on, and a document without one has no identity to address.
 *
 * @param meta The model's metadata.
 * @param idColumn The column name the primary key is stored under.
 */
export function buildValidatorFromColumns(
  columns: Record<string, ColumnConfig>,
  idColumn: string,
): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = ["_id"];

  for (const [key, column] of Object.entries(columns)) {
    const name = column.name ?? key;
    // The primary key lives in `_id`, so the column name is not a field.
    if (key === "id" || name === idColumn) continue;
    properties[name] = mapColumnToBsonSchema(column);
    if (column.required && !column.softDelete) required.push(name);
  }

  return {
    $jsonSchema: {
      bsonType: "object",
      required,
      properties,
    },
  };
}

/** A collection's derived shape: its validator and the indexes it needs. */
export interface MongoCollectionPlan {
  collection: string;
  validator: Record<string, any>;
  indexes: {
    spec: Record<string, 1 | -1>;
    options: Record<string, any>;
  }[];
}

/**
 * Builds the `$jsonSchema` validator for a versioned model's history collection.
 *
 * The model's columns are described exactly as they are in the main collection —
 * a history row *is* the row it recorded — with the audit columns the history
 * writer adds appended.
 *
 * `valid_from` is both declared as a date and required, which is what gives the
 * native-`Date` rule teeth: an ISO string satisfies no `bsonType: "date"` and is
 * rejected by the server on insert, rather than quietly turning every "as of"
 * range query into a comparison between strings.
 *
 * The model's own `required` columns are deliberately **not** required here.
 * `validationLevel: "moderate"` is what keeps a row that predates a newly
 * declared column updatable, and demanding that column of the history row too
 * would then reject the *recording* of exactly the update the level exists to
 * allow.
 *
 * @param columns The model's columns.
 */
export function buildHistoryValidator(
  columns: Record<string, ColumnConfig>,
): Record<string, any> {
  const properties: Record<string, any> = {};

  for (const [key, column] of Object.entries(columns)) {
    // The primary key is a field here, unlike in the main collection: the
    // document's `_id` is the pair that makes one version unique, so the row's
    // own key has nowhere else to live.
    properties[column.name ?? key] = mapColumnToBsonSchema(column);
  }

  properties.operation = { bsonType: "string" };
  properties.version = { bsonType: ["int", "long", "double"] };
  properties.valid_from = { bsonType: "date" };
  properties.valid_to = { bsonType: "date" };
  properties.modified_by = { bsonType: "string" };
  properties.modified_at = { bsonType: "date" };

  return {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "version", "valid_from"],
      properties,
    },
  };
}

/**
 * Derives the history collection a versioned model needs.
 *
 * The history lives beside the model rather than in it — one collection keyed by
 * the row and the version — and has no model of its own, so `autoMigrate` is the
 * only thing that can create it. A model that is not versioned derives nothing.
 *
 * Both indexes serve a read that exists: `{row, version}` is `history()` and the
 * newest-version lookup `rollback` makes, and `{row, valid_from}` is the window
 * `asOf` ranges over. Without the second one the window comparison still works
 * and stops being a range scan of one row's versions.
 *
 * @param model The model to derive from.
 * @returns The history collection plan, or null when the model is not versioned.
 */
export function planMongoHistoryCollection(
  model: any,
): MongoCollectionPlan | null {
  const meta = MetadataStorage.getModelMetadata(model);
  if (!meta?.tableName || !meta.versioned) return null;

  const columns = meta.columns as Record<string, ColumnConfig>;
  const idColumn = columns["id"]?.name ?? "id";

  return {
    collection: `${meta.tableName}_history`,
    validator: buildHistoryValidator(columns),
    indexes: [
      { spec: { [idColumn]: 1, version: 1 }, options: {} },
      { spec: { [idColumn]: 1, valid_from: 1 }, options: {} },
    ],
  };
}

/**
 * Lists the history collections a model set needs.
 *
 * @param models The models being migrated.
 */
export function planMongoHistoryCollections(
  models: any[],
): MongoCollectionPlan[] {
  const plans: MongoCollectionPlan[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const plan = planMongoHistoryCollection(model);
    if (plan && !seen.has(plan.collection)) {
      seen.add(plan.collection);
      plans.push(plan);
    }
  }

  return plans;
}

/**
 * Derives everything a model needs in the database.
 *
 * Pure: no client, no server. That is what makes `generateMongoMigration` able
 * to produce a migration without connecting, and what lets the plan be asserted
 * in a unit test.
 *
 * @param model The model to derive from.
 * @returns The collection plan, or null when the model has no table name.
 */
export function planMongoCollection(model: any): MongoCollectionPlan | null {
  const meta = MetadataStorage.getModelMetadata(model);
  if (!meta?.tableName) return null;

  const columns = meta.columns as Record<string, ColumnConfig>;
  const idColumn = columns["id"]?.name ?? "id";
  const indexes: MongoCollectionPlan["indexes"] = [];

  for (const [key, column] of Object.entries(columns)) {
    const name = column.name ?? key;
    if (key === "id" || name === idColumn) continue;
    if (column.unique) {
      // Sparse, always. See the note at the top of this file.
      indexes.push({ spec: { [name]: 1 }, options: { unique: true, sparse: true } });
    } else if (column.index) {
      indexes.push({ spec: { [name]: 1 }, options: { name: column.index } });
    }
  }

  return {
    collection: meta.tableName,
    validator: buildValidatorFromColumns(columns, idColumn),
    indexes,
  };
}

/**
 * Derives the link collection a many-to-many relation needs.
 *
 * The join table has no model of its own, so `autoMigrate` is the only thing
 * that can create it.
 *
 * The link is keyed by a **compound `_id`** rather than a pair of fields with a
 * unique index over them. MongoDB enforces `_id` uniqueness exactly, so
 * `attach` becomes idempotent at the storage layer instead of by a read the
 * caller has to perform first — and `sync` can report `{attached: 0}` on a
 * second call without having checked anything.
 *
 * @param relation The relation metadata.
 */
export function planMongoLinkCollection(relation: any): MongoCollectionPlan | null {
  if (relation.type !== RelationType.ManyToMany) return null;
  if (!relation.joinTable || !relation.foreignKey || !relation.inverseKey) {
    return null;
  }
  return {
    collection: relation.joinTable,
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id"],
        properties: {
          _id: { bsonType: "object" },
          [relation.foreignKey]: {},
          [relation.inverseKey]: {},
        },
      },
    },
    indexes: [
      { spec: { [relation.inverseKey]: 1 }, options: {} },
      { spec: { [relation.foreignKey]: 1 }, options: {} },
    ],
  };
}

/**
 * Lists the link collections every many-to-many relation in a model set needs.
 *
 * @param models The models being migrated, which may reference each other.
 */
export function planMongoLinkCollections(models: any[]): MongoCollectionPlan[] {
  const plans: MongoCollectionPlan[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const relations = MetadataStorage.getModelMetadata(model)?.relations ?? [];
    for (const relation of relations) {
      const plan = planMongoLinkCollection(relation);
      if (plan && !seen.has(plan.collection)) {
        seen.add(plan.collection);
        plans.push(plan);
      }
    }
  }

  return plans;
}

/**
 * Reports whether a collection already exists.
 *
 * @param db The client to ask.
 * @param collection The collection name.
 */
async function collectionExists(
  db: DBClient,
  collection: string,
): Promise<boolean> {
  const collections = await db.mongoListCollections();
  return collections.some((entry: any) => entry?.name === collection);
}

/**
 * Creates a collection if it is not there yet, and installs its validator.
 *
 * An existing collection is not re-validated here. `collMod` is what changes a
 * validator, and running it on every `autoMigrate` would replace a validator a
 * DBA had tightened by hand.
 *
 * @param db The client to write through.
 * @param plan The collection to ensure.
 */
async function ensureCollection(
  db: DBClient,
  plan: MongoCollectionPlan,
): Promise<void> {
  if (await collectionExists(db, plan.collection)) return;
  await db.mongoCommand({
    create: plan.collection,
    validator: plan.validator,
    // Moderate, always. See the note at the top of this file: "strict" would
    // reject updates to documents that predate a newly required field.
    validationLevel: "moderate",
    validationAction: "error",
  });
}

/**
 * Installs the indexes a collection plan asks for.
 *
 * `createIndex` is idempotent in MongoDB — asking for an index that already
 * exists with the same spec and options is a no-op — so a second `autoMigrate`
 * is safe. Asking for the *same name* with different options is an error
 * (`IndexOptionsConflict`), which is the honest outcome: the change would need a
 * drop first, and guessing that here would drop an index in production.
 *
 * @param db The client to write through.
 * @param plan The collection whose indexes to install.
 */
async function ensureIndexes(
  db: DBClient,
  plan: MongoCollectionPlan,
): Promise<void> {
  for (const index of plan.indexes) {
    await db.mongoCreateIndex(plan.collection, index.spec, index.options);
  }
}

/**
 * Pre-creates a table's counter document.
 *
 * The steady-state allocation path upserts, so this is not required for
 * correctness — but without it the *first* write on a table has two concurrent
 * requests both upserting the same `_id`, and one of them gets a duplicate-key
 * error. Creating it up front (`$setOnInsert`, so an existing counter is left
 * alone) means the concurrent path is always a plain `$inc`.
 *
 * @param db The client to write through.
 * @param collection The table whose counter to create.
 */
async function ensureCounter(db: DBClient, collection: string): Promise<void> {
  await db.mongoUpdateOne(
    MONGO_COUNTERS_COLLECTION,
    { _id: collection },
    { $setOnInsert: { seq: 0 } },
    { upsert: true },
  );
}

/**
 * Whether a model's key is generated rather than supplied by the caller.
 *
 * Mirrors `Repository#getAutoIncrementField`, and must keep mirroring it: if
 * this created a counter for a table whose keys are strings, the counter would
 * simply never be read.
 *
 * @param columns The model's columns.
 */
function usesGeneratedIds(columns: Record<string, ColumnConfig>): boolean {
  const idColumn = columns["id"];
  if (!idColumn) return false;
  const type = (
    typeof idColumn.type === "string" ? idColumn.type : DataTypes[idColumn.type]
  ).toUpperCase();
  return type !== "STRING" && type !== "TEXT" && type !== "UUID";
}

/**
 * Brings a set of models' collections in line with their declarations.
 *
 * The add-only contract the SQL side has is expressed here against the
 * validator rather than against sampled documents, because a document either
 * carries a field or does not — there is nothing to backfill. A document without
 * the field reads back `undefined`, which is exactly what `ADD COLUMN` with no
 * default produces anyway.
 *
 * @param db The client to migrate through.
 * @param models The models to bring up to date.
 */
export async function mongoAutoMigrate(
  db: DBClient,
  models: any[],
): Promise<void> {
  const plans: MongoCollectionPlan[] = [];
  for (const model of models) {
    const plan = planMongoCollection(model);
    if (!plan) {
      throw new StabilizeError(
        `Model is missing tableName. Use defineModel() or add static schema.`,
        "MIGRATE_ERROR",
      );
    }
    plans.push(plan);
  }
  plans.push(...planMongoLinkCollections(models));
  plans.push(...planMongoHistoryCollections(models));

  for (const plan of plans) {
    await ensureCollection(db, plan);
    await ensureIndexes(db, plan);
  }

  // The counters collection itself, so a fresh database has somewhere for the
  // first allocation to land.
  await ensureCollection(db, {
    collection: MONGO_COUNTERS_COLLECTION,
    validator: {},
    indexes: [],
  });

  for (const model of models) {
    const meta = MetadataStorage.getModelMetadata(model);
    if (!meta) continue;
    if (usesGeneratedIds(meta.columns as Record<string, ColumnConfig>)) {
      await ensureCounter(db, meta.tableName);
    }
  }
}

/**
 * Builds the migration steps that would bring a model's collection up to date.
 *
 * Pure, so a migration can be generated — and asserted — without a server.
 *
 * @param model The model to generate for.
 * @param direction Whether this is the `up` or the `down` direction.
 */
export function generateMongoSteps(
  model: any,
  direction: "up" | "down",
): MongoStep[] {
  const plan = planMongoCollection(model);
  if (!plan) return [];

  // A versioned model's history collection is part of what a migration brings
  // into existence, so it travels with the collection it belongs to in both
  // directions. Left out of the `down`, a dropped model would keep its audit
  // trail.
  const history = planMongoHistoryCollection(model);
  const collections = history ? [plan, history] : [plan];

  if (direction === "down") {
    // Dropping the collection is the only inverse that is actually total: the
    // indexes and the validator go with it, so a re-`up` rebuilds from the
    // declaration rather than from whatever survived.
    return collections.map((each) => ({
      kind: "dropCollection" as const,
      collection: each.collection,
    }));
  }

  const steps: MongoStep[] = [];
  for (const each of collections) {
    steps.push({
      kind: "createCollection",
      collection: each.collection,
      validator: each.validator,
    });
    for (const index of each.indexes) {
      steps.push({
        kind: "createIndex",
        collection: each.collection,
        spec: index.spec,
        options: index.options,
      });
    }
  }
  return steps;
}

/** Reports whether a model's key is generated. @see usesGeneratedIds */
export function modelUsesGeneratedIds(model: any): boolean {
  const meta = MetadataStorage.getModelMetadata(model);
  if (!meta) return false;
  return usesGeneratedIds(meta.columns as Record<string, ColumnConfig>);
}

/** The collection a model is stored in. */
export function mongoCollectionName(model: any): string | null {
  return MetadataStorage.getModelMetadata(model)?.tableName ?? null;
}
