/**
 * @file mongo-repository.ts
 * @description The MongoDB bodies behind `Repository`'s write paths.
 * @author ElectronSz
 *
 * Kept beside `repository.ts` rather than inside it because the two storage
 * models agree on almost nothing at the statement level: `INSERT … VALUES` and
 * `insertOne(doc)` share no structure to factor out. What they *do* share —
 * validation, hooks, timestamps, the optimistic-lock seed, encryption, relation
 * loading and cache invalidation — stays on the repository and reaches these
 * bodies through {@link MongoRepositoryHost}, so none of it is reimplemented.
 *
 * Documents are keyed by the model's **column name** (`col.name ?? key`), with
 * the primary key stored as `_id`. That is the decision that keeps this file
 * small: every relation loader, cache key, history writer and transform in the
 * repository is already written against column names, so they work unchanged.
 */

import { DBClient } from "./client";
import { StabilizeError } from "./types";
import {
  type MongoAggregate,
  OMIT,
  buildMongoAggregatePipeline,
  normalizeMongoDoc,
  sanitizeMongoValue,
} from "./mongo-query";

/**
 * The collection auto-increment ids are drawn from.
 *
 * One document per table, `_id` being the table name — so uniqueness is
 * enforced by the storage layer instead of by a read-then-write the caller
 * would have to get right.
 */
export const MONGO_COUNTERS_COLLECTION = "stabilize_counters";

/** A column as the write bodies need to see it. */
export interface MongoColumn {
  name: string;
  encrypted?: boolean;
}

/**
 * The three names a many-to-many link is addressed by.
 *
 * The join collection has no model of its own, so nothing here resolves
 * through column metadata — these names come from the relation config and are
 * used verbatim, exactly as the SQL path uses them as table and column names.
 */
export interface MongoLinkRelation {
  joinTable: string;
  foreignKey: string;
  inverseKey: string;
}

/**
 * The composite `_id` a link document is keyed by.
 *
 * `_id` uniqueness is the one uniqueness constraint MongoDB enforces on every
 * collection without an index being declared, so keying the link by the pair
 * makes `attach` idempotent at the storage layer: the second insert of the same
 * pair cannot land, whether or not the caller checked first. The SQL join table
 * has no such constraint and needs the pre-read to avoid a duplicate row.
 *
 * One function, so the shape the writer builds is the shape the reader matches.
 */
function linkId(parent: any, child: any): { p: any; c: any } {
  return { p: parent, c: child };
}

/**
 * The parts of a `Repository` the MongoDB write bodies depend on.
 *
 * Deliberately narrow and structural: `Repository` satisfies it through an
 * adapter object built inside the class, which keeps these bodies testable
 * without a repository and keeps every member it touches explicit.
 */
export interface MongoRepositoryHost {
  /** The collection this repository writes to. */
  table: string;
  /** Property key → column. Always normalised, see the `Repository` constructor. */
  columns: Record<string, MongoColumn>;
  /** The primary-key property name. `"id"` by convention. */
  idProperty: string;
  /** The primary-key column name, which `_id` stores. */
  idColumn: string;
  /**
   * The property auto-increment ids are generated for, or null when the key is
   * caller-supplied (a UUID or string id).
   */
  autoIncrementField: string | null;
  /** The soft-delete property key, or null when the model does not soft-delete. */
  softDeleteField: string | null;
  /** The soft-delete *column* name. @see softDeleteField */
  softDeleteColumn: string | null;
  /** The optimistic-lock property key, or null when the model has no lock. */
  optimisticLockField: string | null;
  /** The optimistic-lock *column* name. @see optimisticLockField */
  optimisticLockColumn: string | null;
  /** The timestamp property keys, or null when timestamps are off. */
  timestamps: { createdAt?: string; updatedAt?: string } | null;
  /**
   * The collection a versioned model's history documents are written to. Always
   * set, because only a versioned repository reaches the bodies that use it.
   */
  historyTable: string;
  logger: { logDebug(message: string): void };
  /** Throws when the entity fails the model's validators. */
  validate(entity: any, skipRequired?: boolean): void;
  /** Applies the timestamp and optimistic-lock defaults a create writes. */
  seedCreateDefaults(entity: Record<string, any>): Record<string, any>;
  /** Encrypts encrypted columns and normalises values for storage. */
  processForSave(entity: Record<string, any>): Record<string, any>;
  /** Decrypts encrypted columns. */
  processForLoad(row: any): any;
  findOne(
    id: number | string,
    options: { relations?: string[] },
    client: DBClient,
  ): Promise<any>;
  loadRelations(
    rows: any[],
    relations: string[] | undefined,
    client: DBClient,
  ): Promise<any[]>;
  invalidateRowCache(id: number | string): Promise<void>;
  invalidateTableCache(): Promise<void>;
  writeThroughRow(id: number | string, row: any): Promise<void>;
}

/**
 * Reads the sequence number out of a `findOneAndUpdate` reply.
 *
 * Driver 6 returns the document itself — `includeResultMetadata` has defaulted
 * to false since NODE-3568 — where driver 5 returned a `ModifyResult` wrapping
 * it in `value`. Both are read rather than one being assumed, and neither being
 * present is an error: a silent `undefined` here would allocate `NaN` ids and
 * fail much later, somewhere else.
 *
 * @param reply Whatever the driver handed back.
 * @param table The collection the counter belongs to, for the message.
 * @throws StabilizeError `MONGO_COUNTER_ERROR` when no sequence number is present.
 */
function readCounterSeq(reply: any, table: string): number {
  const seq = reply?.seq ?? reply?.value?.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    throw new StabilizeError(
      `MongoDB counter for '${table}' did not return a sequence number. ` +
        `Expected a numeric 'seq' field on the counters document.`,
      "MONGO_COUNTER_ERROR",
    );
  }
  return seq;
}

/**
 * Reports whether an error is a duplicate-key violation.
 *
 * The driver's own error is usually wrapped by `mongoRun` in a `StabilizeError`,
 * so the code is looked for on the error and on everything it was caused by.
 *
 * @param error The error to inspect.
 */
function isDuplicateKey(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === 11000) return true;
    if (typeof current.message === "string" && current.message.includes("E11000")) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Reserves a contiguous block of ids for one collection.
 *
 * One `$inc` allocates the whole block, so a batch of twenty costs one round
 * trip and yields exactly twenty consecutive ids — where the SQL path has to
 * guess which rows a multi-row `INSERT` produced.
 *
 * `$inc` against a field that does not exist yet initialises it to the
 * increment, so a brand-new collection yields ids starting at 1.
 *
 * @param client The client to allocate through.
 * @param table The collection the ids belong to.
 * @param count How many ids to reserve. Zero or fewer allocates nothing.
 * @returns The reserved ids, ascending.
 * @throws StabilizeError `MONGO_COUNTER_ERROR` if the counter reports no sequence.
 */
export async function allocateMongoIds(
  client: DBClient,
  table: string,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];

  const bump = () =>
    client.mongoFindOneAndUpdate(
      MONGO_COUNTERS_COLLECTION,
      { _id: table },
      { $inc: { seq: count } },
      { upsert: true, returnDocument: "after" },
    );

  let reply: any;
  try {
    reply = await bump();
  } catch (error) {
    // Two upserts racing on the same counter `_id`: the loser gets a
    // duplicate-key error instead of an id. One retry settles it, because by
    // then the document exists and the same call is an ordinary `$inc`.
    if (!isDuplicateKey(error)) throw error;
    reply = await bump();
  }

  const last = readCounterSeq(reply, table);
  const first = last - count + 1;
  return Array.from({ length: count }, (_, offset) => first + offset);
}

/**
 * Raises a counter so it is at least `maxId`.
 *
 * A caller-supplied id has to move the counter, or the next generated id would
 * collide with it. SQLite gets this for free from `sqlite_sequence`; MongoDB
 * needs it said out loud. `$max` rather than a write, so an id below the current
 * sequence — a caller re-inserting a row it read — leaves the counter alone.
 *
 * @param client The client to write through.
 * @param table The collection the counter belongs to.
 * @param maxId The highest caller-supplied id in this write.
 */
export async function advanceMongoCounter(
  client: DBClient,
  table: string,
  maxId: number,
): Promise<void> {
  await client.mongoUpdateOne(
    MONGO_COUNTERS_COLLECTION,
    { _id: table },
    { $max: { seq: maxId } },
    { upsert: true },
  );
}

/**
 * Turns a prepared entity into the document that gets stored.
 *
 * The primary key is left out: it is written as `_id` by the caller, which is
 * what gives the collection a unique index on it for free.
 *
 * `sanitizeMongoValue` returns {@link OMIT} for `null` and `undefined`, and the
 * key is dropped rather than stored as an explicit null. Storing it would put an
 * explicit null in every column the caller did not mention, and a sparse unique
 * index treats two explicit nulls as a collision — so a second document omitting
 * a unique column would be rejected.
 *
 * @param host The repository the entity belongs to.
 * @param entity An entity already through `processForSave`.
 */
function buildMongoDocument(
  host: MongoRepositoryHost,
  entity: Record<string, any>,
): Record<string, any> {
  const document: Record<string, any> = {};
  for (const [key, value] of Object.entries(entity)) {
    const column = host.columns[key];
    if (!column) continue;
    if (key === host.idProperty) continue;
    const sanitized = sanitizeMongoValue(value);
    if (sanitized === OMIT) continue;
    document[column.name] = sanitized;
  }
  return document;
}

/**
 * Splits an array into chunks of at most `size`.
 *
 * @param items The array to split.
 * @param size The largest chunk to produce.
 */
function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Turns a prepared patch into `$set`/`$unset` halves.
 *
 * The difference from {@link buildMongoDocument} is what a null means. On an
 * insert it means "this column was not supplied", so the key is dropped. On an
 * update it means "clear this column", which on a document store is `$unset` —
 * dropping the key would leave the old value in place and silently ignore the
 * caller. SQL spells both the same way (`SET col = NULL`), which is why the two
 * builders cannot be one.
 *
 * @param host The repository the patch belongs to.
 * @param prepared A patch already through `processForSave`.
 */
function buildMongoPatch(
  host: MongoRepositoryHost,
  prepared: Record<string, any>,
): { $set: Record<string, any>; $unset: Record<string, any> } {
  const $set: Record<string, any> = {};
  const $unset: Record<string, any> = {};
  for (const [key, value] of Object.entries(prepared)) {
    const column = host.columns[key];
    // The primary key is `_id`, which is never patched: a change of identity is
    // a delete and an insert, not an update.
    if (!column || key === host.idProperty) continue;
    const sanitized = sanitizeMongoValue(value);
    if (sanitized === OMIT) $unset[column.name] = "";
    else $set[column.name] = sanitized;
  }
  return { $set, $unset };
}

/**
 * Assembles the update document, leaving out the halves that are empty.
 *
 * MongoDB rejects `$set: {}` as an empty operator, so an absent half has to be
 * an absent key rather than an empty object.
 */
function updateOperation(
  $set: Record<string, any>,
  $unset: Record<string, any>,
): Record<string, any> {
  const operation: Record<string, any> = {};
  if (Object.keys($set).length > 0) operation.$set = $set;
  if (Object.keys($unset).length > 0) operation.$unset = $unset;
  return operation;
}

/**
 * Turns a set of equality conditions into a filter.
 *
 * The soft-delete clause is deliberately *not* added here: the operations that
 * want it differ in the direction they want it, so each caller adds its own.
 *
 * @param host The repository the conditions belong to.
 * @param conditions Property key → value, as the public methods take them.
 * @param options `skipNull` matches `restoreBy`'s behaviour of ignoring a null
 *   condition rather than treating it as `IS NULL`.
 * @throws StabilizeError `UNSAFE_QUERY` when the conditions name no known
 *   column: the repository has already refused a *caller* that passed nothing,
 *   but a condition set of unknown keys would otherwise become an empty filter,
 *   which is the same statement with no WHERE clause this is meant to prevent.
 */
function buildMongoConditions(
  host: MongoRepositoryHost,
  conditions: Record<string, any>,
  options: { skipNull?: boolean } = {},
): Record<string, any> {
  const filter: Record<string, any> = {};
  for (const [key, value] of Object.entries(conditions)) {
    const column = host.columns[key];
    if (!column) continue;
    if (value === null || value === undefined) {
      if (options.skipNull) continue;
      // `{field: null}` matches a document where the field is null *or absent*,
      // which is what SQL's `IS NULL` means for a column that always exists.
      filter[column.name] = null;
      continue;
    }
    filter[column.name] = sanitizeMongoValue(value);
  }

  if (Object.keys(conditions).length > 0 && Object.keys(filter).length === 0) {
    throw new StabilizeError(
      `None of the conditions ${JSON.stringify(Object.keys(conditions))} name a column of ${host.table}; refusing to affect every document.`,
      "UNSAFE_QUERY",
    );
  }
  return filter;
}

/**
 * Reads an affected-row count out of a driver write result.
 *
 * Driver 6 reports `matchedCount` for an update and `deletedCount` for a
 * delete. Driver 5 nested both under `result.n`, so that spelling is read too —
 * a silent zero here would make `updateBy` report having changed nothing while
 * the write had actually landed.
 */
function affectedRows(
  result: any,
  field: "matchedCount" | "deletedCount",
): number {
  const direct = result?.[field];
  if (typeof direct === "number") return direct;
  const legacy = result?.result?.n;
  return typeof legacy === "number" ? legacy : 0;
}

/** The soft-delete filter that keeps a write to rows that are not deleted. */
function notDeletedFilter(host: MongoRepositoryHost): Record<string, any> {
  const column = host.softDeleteColumn;
  if (!host.softDeleteField || !column) return {};
  return { [column]: null };
}

/**
 * Inserts one entity.
 *
 * The read-back goes through `findOne` rather than reusing the document that
 * was just inserted, so the row a caller receives has been through exactly the
 * same decryption and relation loading a later read would apply.
 *
 * @param host The repository being written through.
 * @param entity The entity, after the create hooks have run.
 * @param options Relation paths to eager-load onto the result.
 * @param client The client, which supplies the session and the collection.
 * @returns The stored entity.
 */
export async function mongoCreate(
  host: MongoRepositoryHost,
  entity: Record<string, any>,
  options: { relations?: string[] },
  client: DBClient,
): Promise<any> {
  const start = Date.now();
  host.logger.logDebug(
    `Creating ${host.table} with data: ${JSON.stringify(entity)}`,
  );
  host.validate(entity);

  const prepared = host.processForSave(host.seedCreateDefaults(entity));
  const document = buildMongoDocument(host, prepared);

  const explicit = prepared[host.idProperty];
  if (explicit !== undefined && explicit !== null) {
    document._id = explicit;
    // A numeric key has to move the counter past it, or the next generated id
    // is handed out again and collides with this row.
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      await advanceMongoCounter(client, host.table, explicit);
    }
  } else if (host.autoIncrementField) {
    document._id = (await allocateMongoIds(client, host.table, 1))[0];
  }

  await client.mongoInsertOne(host.table, document);
  const id = document._id;

  const result = await host.findOne(id, options, client);

  await host.invalidateRowCache(id);
  await host.writeThroughRow(id, result);

  host.logger.logDebug(
    `Created ${host.table} with ID ${id} in ${Date.now() - start}ms`,
  );
  return result;
}

/**
 * Inserts many entities.
 *
 * Two divergences from the SQL path, both because documents are independent:
 * the key sets are not unioned across the batch (that exists to build a single
 * multi-row `VALUES` list, which has no analogue here), and the results are not
 * re-read from the server. The SQL path re-reads because a multi-row `INSERT`
 * does not say which keys it generated; here they are allocated up front and the
 * documents that were sent *are* the rows, so a round trip would only be able to
 * agree with what is already in hand.
 *
 * @param host The repository being written through.
 * @param entities The entities, after the create hooks have run.
 * @param options Batch size and relation paths to eager-load.
 * @param client The client, which supplies the session and the collection.
 * @returns The stored entities, in the order they were given.
 */
export async function mongoBulkCreate(
  host: MongoRepositoryHost,
  entities: Record<string, any>[],
  options: { relations?: string[]; batchSize?: number },
  client: DBClient,
): Promise<any[]> {
  const start = Date.now();
  host.logger.logDebug(
    `Bulk creating ${entities.length} ${host.table} entities`,
  );
  if (!entities.length) return [];

  const batchSize = options.batchSize || 1000;
  entities.forEach((entity) => host.validate(entity));

  const prepared = entities.map((entity) =>
    host.processForSave(host.seedCreateDefaults(entity)),
  );

  const results: any[] = [];

  for (const batch of chunked(prepared, batchSize)) {
    const explicitIds = batch
      .map((row) => row[host.idProperty])
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    if (explicitIds.length > 0) {
      await advanceMongoCounter(
        client,
        host.table,
        Math.max(...explicitIds),
      );
    }

    const generatedCount = batch.filter(
      (row) => row[host.idProperty] === undefined || row[host.idProperty] === null,
    ).length;
    const generated = await allocateMongoIds(client, host.table, generatedCount);

    let next = 0;
    const documents = batch.map((row) => {
      const document = buildMongoDocument(host, row);
      const explicit = row[host.idProperty];
      if (explicit !== undefined && explicit !== null) {
        document._id = explicit;
      } else {
        document._id = generated[next++];
      }
      return document;
    });

    await client.mongoInsertMany(host.table, documents);
    results.push(
      ...documents.map((document) =>
        host.processForLoad(normalizeMongoDoc(document, host.idColumn)),
      ),
    );
  }

  await host.invalidateTableCache();
  await host.loadRelations(results, options.relations, client);

  host.logger.logDebug(
    `Bulk created ${results.length} ${host.table} entities in ${Date.now() - start}ms`,
  );
  return results;
}

/**
 * Applies a patch to one row.
 *
 * The optimistic lock is advanced inside the same update and matched on in the
 * filter, which is the whole mechanism: a filter that no longer matches is a
 * conflict, and `matchedCount === 0` is how it is noticed. Doing the read and
 * the compare as separate round trips would let two writers pass the check
 * together and lose one of the updates.
 *
 * @param host The repository being written through.
 * @param id The row to patch.
 * @param entity The caller's patch.
 * @param before The row as it was read, for the lock value the caller did not
 *   supply.
 * @param client The client, which supplies the session and the collection.
 * @returns The stored entity.
 * @throws StabilizeError `CONCURRENT_MODIFICATION` when the lock filter misses.
 */
export async function mongoUpdate(
  host: MongoRepositoryHost,
  id: number | string,
  entity: Record<string, any>,
  before: any,
  client: DBClient,
): Promise<any> {
  const start = Date.now();
  host.logger.logDebug(`Updating ${host.table} with ID ${id}`);
  // The payload is a partial patch, exactly like the SQL path's: required
  // columns that are not being changed must not be demanded here.
  host.validate(entity, true);

  const prepared: Record<string, any> = { ...entity };
  const timestamps = host.timestamps;
  if (timestamps?.updatedAt && !prepared[timestamps.updatedAt]) {
    prepared[timestamps.updatedAt] = new Date().toISOString();
  }
  // Encrypt and coerce after the timestamp is in place, so it passes through
  // the same treatment everything else does.
  Object.assign(prepared, host.processForSave(prepared));

  let lockValue: any;
  if (host.optimisticLockField) {
    // Rows can arrive keyed by property or by column, so both are read — a
    // renamed lock column would otherwise be undefined and the lock would
    // silently do nothing.
    lockValue =
      before?.[host.optimisticLockField] ??
      (host.optimisticLockColumn
        ? before?.[host.optimisticLockColumn]
        : undefined);

    // A caller that passes the version it read expects a conflict if someone
    // else has written since, so the caller's value wins over the one just
    // read inside this transaction, which would always match.
    const callerVersion = entity[host.optimisticLockField];
    const expected =
      callerVersion !== undefined && callerVersion !== null
        ? callerVersion
        : lockValue;

    if (expected !== undefined) {
      lockValue = expected;
      prepared[host.optimisticLockField] =
        typeof expected === "number" ? expected + 1 : 1;
    }
  }

  const { $set, $unset } = buildMongoPatch(host, prepared);
  const operation = updateOperation($set, $unset);

  const filter: Record<string, any> = { _id: id };
  if (host.optimisticLockField && lockValue !== undefined) {
    // A null version is matched with `{col: null}`, which covers both a stored
    // null and an absent field. SQL needs `IS NULL` there because `= NULL` is
    // never true; here the one filter already means both.
    filter[host.optimisticLockColumn!] = lockValue ?? null;
  }
  if (host.softDeleteField) {
    filter[host.softDeleteColumn!] = null;
  }

  // An update with no operators is rejected outright by the driver, so a patch
  // that changes nothing writes nothing. The SQL path produces `SET` with an
  // empty list there, which is a syntax error — but only for a payload that
  // carries just the key, and doing nothing is the honest reading of that.
  if (Object.keys(operation).length > 0) {
    const result = await client.mongoUpdateOne(host.table, filter, operation);
    if (
      host.optimisticLockField &&
      lockValue !== undefined &&
      affectedRows(result, "matchedCount") === 0
    ) {
      throw new StabilizeError(
        `Record was modified by another transaction (optimistic lock conflict on ${host.optimisticLockField})`,
        "CONCURRENT_MODIFICATION",
      );
    }
  }

  const result = await host.findOne(id, {}, client);

  await host.invalidateRowCache(id);
  await host.writeThroughRow(id, result);

  host.logger.logDebug(
    `Updated ${host.table} with ID ${id} in ${Date.now() - start}ms`,
  );
  return result;
}

/**
 * Removes one row, softly when the model soft-deletes.
 *
 * The soft-delete stamp is a native `Date`, not an ISO string: the "is this row
 * deleted" filter is a comparison, and a string would compare lexically against
 * whatever else is in the column.
 *
 * @param host The repository being written through.
 * @param id The row to remove.
 * @param client The client, which supplies the session and the collection.
 */
export async function mongoDeleteRow(
  host: MongoRepositoryHost,
  id: number | string,
  client: DBClient,
): Promise<void> {
  const start = Date.now();
  host.logger.logDebug(`Deleting ${host.table} with ID ${id}`);

  if (host.softDeleteField) {
    await client.mongoUpdateOne(
      host.table,
      { _id: id },
      { $set: { [host.softDeleteColumn!]: new Date() } },
    );
  } else {
    await client.mongoDeleteOne(host.table, { _id: id });
  }

  await host.invalidateRowCache(id);
  host.logger.logDebug(
    `Deleted ${host.table} with ID ${id} in ${Date.now() - start}ms`,
  );
}

/**
 * Clears a row's soft-delete stamp.
 *
 * `$unset` rather than a stored null, for the same reason the insert path omits
 * null keys: an absent field is what "not deleted" looks like everywhere else
 * in this backend, and writing an explicit null would make the state
 * unrepresentable in a sparse index later.
 *
 * @param host The repository being written through.
 * @param id The row to recover.
 * @param client The client, which supplies the session and the collection.
 */
export async function mongoRecover(
  host: MongoRepositoryHost,
  id: number | string,
  client: DBClient,
): Promise<void> {
  await client.mongoUpdateOne(
    host.table,
    { _id: id },
    { $unset: { [host.softDeleteColumn!]: "" } },
  );
}

/**
 * Writes the row an upsert lands on, and reads it back.
 *
 * The conflict keys are the filter and the payload is the update, in one
 * `findOneAndUpdate` with `upsert: true` — so two callers racing on a key that
 * does not exist yet cannot both insert. `before` is passed in only because the
 * repository has already resolved it to choose the hook pair; the write does
 * not depend on it being right.
 *
 * The generated `_id` is allocated before the write, which means the loser of
 * such a race burns an id. That gap is the same one MySQL and SQLite leave when
 * a rolled-back insert consumes an auto-increment value, and the alternative —
 * reading the counter back after inserting — needs an `_id` that does not exist
 * yet.
 *
 * @param host The repository being written through.
 * @param keys The conflict-key property names. Empty means an unconditional
 *   insert, since there is nothing to match on and an empty filter would match
 *   an arbitrary document.
 * @param values The payload, already through `processForSave`.
 * @param before The row the conflict keys resolved to, or null.
 * @param client The client, which supplies the session and the collection.
 * @returns The stored row, normalised.
 */
export async function mongoUpsertRow(
  host: MongoRepositoryHost,
  keys: string[],
  values: Record<string, any>,
  before: any,
  client: DBClient,
): Promise<any> {
  const existingId =
    before?.[host.idProperty] ??
    (host.idColumn ? before?.[host.idColumn] : undefined);

  if (existingId !== undefined && existingId !== null) {
    const { $set, $unset } = buildMongoPatch(host, values);
    const operation = updateOperation($set, $unset);
    if (Object.keys(operation).length > 0) {
      await client.mongoUpdateOne(host.table, { _id: existingId }, operation);
    }
    return host.processForLoad(
      normalizeMongoDoc(
        await client.mongoFindOne(host.table, { _id: existingId }),
        host.idColumn,
      ),
    );
  }

  const document = buildMongoDocument(host, values);
  const explicit = values[host.idProperty];

  if (explicit !== undefined && explicit !== null) {
    document._id = explicit;
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      await advanceMongoCounter(client, host.table, explicit);
    }
  } else if (host.autoIncrementField) {
    document._id = (await allocateMongoIds(client, host.table, 1))[0];
  }

  if (keys.length === 0) {
    await client.mongoInsertOne(host.table, document);
    return host.processForLoad(normalizeMongoDoc(document, host.idColumn));
  }

  const conflict = buildMongoConditions(
    host,
    Object.fromEntries(keys.map((key) => [key, values[key]])),
  );

  const { $set, $unset } = buildMongoPatch(host, values);
  const operation = updateOperation($set, $unset);
  Object.assign(operation, { $setOnInsert: { _id: document._id } });

  try {
    const reply = await client.mongoFindOneAndUpdate(host.table, conflict, operation, {
      upsert: true,
      returnDocument: "after",
    });
    return host.processForLoad(normalizeMongoDoc(reply, host.idColumn));
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // The other upsert won the insert between the read and this write, so the
    // key exists now and the same operation is an ordinary update. The id
    // allocated above goes unused, which is the gap noted on this function.
    const reply = await client.mongoFindOneAndUpdate(
      host.table,
      conflict,
      updateOperation($set, $unset),
      { returnDocument: "after" },
    );
    return host.processForLoad(normalizeMongoDoc(reply, host.idColumn));
  }
}

/**
 * Adds `amount` to one numeric column.
 *
 * `$inc` is server-side, so two concurrent callers both land — which the SQL
 * `col = col + ?` also guarantees. One divergence is worth knowing: `$inc`
 * against a field that is *absent* initialises it to the increment, where SQL
 * would compute `NULL + n` and leave the column NULL. On SQL the caller gets a
 * null back; here it gets the amount. Neither is wrong, but a caller relying on
 * the SQL behaviour will see a different value.
 *
 * @param host The repository being written through.
 * @param id The row to change.
 * @param column The column property name.
 * @param amount How much to add. Negative values subtract.
 * @param client The client, which supplies the session and the collection.
 */
export async function mongoIncrement(
  host: MongoRepositoryHost,
  id: number | string,
  column: string,
  amount: number,
  client: DBClient,
): Promise<void> {
  const field = host.columns[column]?.name ?? column;
  await client.mongoUpdateOne(
    host.table,
    { _id: id, ...notDeletedFilter(host) },
    { $inc: { [field]: amount } },
  );
}

/**
 * Flips a boolean column.
 *
 * A pipeline update, because there is no update operator that reads a field in
 * order to write it. The comparison is against `true`, which is the value the
 * ORM stores for a boolean column on this backend — the SQL path's
 * `CASE WHEN col = 1` is about the 1/0 that SQLite and MySQL are handed, and a
 * document that has never been written reads as `false` and flips to `true`,
 * which is what a missing column means here anyway.
 *
 * @param host The repository being written through.
 * @param id The row to change.
 * @param column The column property name.
 * @param client The client, which supplies the session and the collection.
 */
export async function mongoToggle(
  host: MongoRepositoryHost,
  id: number | string,
  column: string,
  client: DBClient,
): Promise<void> {
  const field = host.columns[column]?.name ?? column;
  await client.mongoUpdateOne(
    host.table,
    { _id: id, ...notDeletedFilter(host) },
    [
      {
        $set: {
          [field]: { $cond: [{ $eq: [`$${field}`, true] }, false, true] },
        },
      },
    ],
  );
}

/**
 * Applies one patch to every row a condition set matches.
 *
 * @param host The repository being written through.
 * @param conditions Property key → value.
 * @param values The patch, already through `processForSave`.
 * @param client The client, which supplies the session and the collection.
 * @returns How many rows matched, which is zero when the patch is empty.
 */
export async function mongoUpdateMany(
  host: MongoRepositoryHost,
  conditions: Record<string, any>,
  values: Record<string, any>,
  client: DBClient,
): Promise<number> {
  const { $set, $unset } = buildMongoPatch(host, values);
  const operation = updateOperation($set, $unset);

  // A bulk update advances the version too, so the rows it touched are not left
  // holding a version that no longer matches and rejecting the next ordinary
  // write as a conflict. `$inc` and `$set` cannot touch the same path, so this
  // is only added when the patch did not set the lock itself.
  if (host.optimisticLockField && !(host.optimisticLockField in values)) {
    const lockField = host.columns[host.optimisticLockField]!.name;
    operation.$inc = { [lockField]: 1 };
  }

  if (Object.keys(operation).length === 0) return 0;

  const filter = buildMongoConditions(host, conditions);
  if (host.softDeleteField) filter[host.softDeleteColumn!] = null;

  const result = await client.mongoUpdateMany(host.table, filter, operation);
  return affectedRows(result, "matchedCount");
}

/**
 * Removes every row a condition set matches, softly when the model soft-deletes.
 *
 * @param host The repository being written through.
 * @param conditions Property key → value.
 * @param client The client, which supplies the session and the collection.
 * @returns How many rows matched.
 */
export async function mongoDeleteManyBy(
  host: MongoRepositoryHost,
  conditions: Record<string, any>,
  client: DBClient,
): Promise<number> {
  const filter = buildMongoConditions(host, conditions);

  if (host.softDeleteField) {
    filter[host.softDeleteColumn!] = null;
    const result = await client.mongoUpdateMany(host.table, filter, {
      $set: { [host.softDeleteColumn!]: new Date() },
    });
    return affectedRows(result, "matchedCount");
  }

  const result = await client.mongoDeleteMany(host.table, filter);
  return affectedRows(result, "deletedCount");
}

/**
 * Clears the soft-delete stamp on every row a condition set matches.
 *
 * A null or undefined condition is skipped rather than matched, which is what
 * the SQL path does: `restoreBy({tag: null})` restores everything whose tag is
 * null *or* everything at all, depending on the backend, so the condition is
 * dropped instead of being given a meaning the callers never agreed on.
 *
 * @param host The repository being written through.
 * @param conditions Property key → value.
 * @param client The client, which supplies the session and the collection.
 * @returns How many rows matched.
 */
export async function mongoRestoreManyBy(
  host: MongoRepositoryHost,
  conditions: Record<string, any>,
  client: DBClient,
): Promise<number> {
  const filter = buildMongoConditions(host, conditions, { skipNull: true });
  filter[host.softDeleteColumn!] = { $ne: null };

  const result = await client.mongoUpdateMany(host.table, filter, {
    $unset: { [host.softDeleteColumn!]: "" },
  });
  return affectedRows(result, "matchedCount");
}

/**
 * Runs the aggregates `aggregate()` was asked for, as one `$group`.
 *
 * The alias names match the SQL path's, because they are what the caller reads
 * the answer out of — `count_all` for `count: "*"` and `${fn}_${column}`
 * otherwise.
 *
 * @param host The repository being written through.
 * @param options The requested aggregates.
 * @param client The client, which supplies the session and the collection.
 * @returns One row of results, or `{}` when nothing was asked for.
 */
export async function mongoAggregateRows(
  host: MongoRepositoryHost,
  options: {
    count?: string | string[];
    sum?: string[];
    avg?: string[];
    min?: string[];
    max?: string[];
  },
  client: DBClient,
): Promise<Record<string, any>> {
  const aggregates: MongoAggregate[] = [];

  for (const column of options.count
    ? Array.isArray(options.count)
      ? options.count
      : [options.count]
    : []) {
    aggregates.push({
      fn: "count",
      column: column === "*" ? "*" : (host.columns[column]?.name ?? column),
      alias: column === "*" ? "count_all" : `count_${column}`,
    });
  }
  for (const [fn, columns] of [
    ["sum", options.sum],
    ["avg", options.avg],
    ["min", options.min],
    ["max", options.max],
  ] as const) {
    for (const column of columns ?? []) {
      aggregates.push({
        fn,
        column: host.columns[column]?.name ?? column,
        alias: `${fn}_${column}`,
      });
    }
  }

  if (aggregates.length === 0) return {};

  const rows = await client.mongoAggregate(
    host.table,
    buildMongoAggregatePipeline(notDeletedFilter(host), aggregates, {
      primaryKey: host.idColumn,
      idProperty: host.idProperty,
    }),
  );
  if (rows[0]) return rows[0];

  // A `$group` over an empty input produces *no documents at all*, where SQL's
  // aggregate query returns one row of zeroes and NULLs. Without this the count
  // of nothing comes back `undefined` rather than 0, and a caller doing
  // arithmetic on it gets `NaN` — a wrong answer with no error, on the one
  // input (an empty table) that a fresh install always has.
  const empty: Record<string, any> = {};
  for (const aggregate of aggregates) {
    empty[aggregate.alias] = aggregate.fn === "count" ? 0 : null;
  }
  return empty;
}

/**
 * Counts the distinct non-null values of one column.
 *
 * SQL's `COUNT(DISTINCT col)` skips NULLs; Mongo's `distinct` returns them as a
 * value like any other, so an explicit `null` would make the count one too high
 * for every column that has one.
 *
 * @param host The repository being written through.
 * @param column The column property name.
 * @param client The client, which supplies the session and the collection.
 */
export async function mongoCountDistinct(
  host: MongoRepositoryHost,
  column: string,
  client: DBClient,
): Promise<number> {
  const field = host.columns[column]?.name ?? column;
  const values = await client.mongoDistinct(
    host.table,
    field,
    notDeletedFilter(host),
  );
  return values.filter((value) => value !== null && value !== undefined).length;
}

/**
 * Picks a row at random, by its id.
 *
 * `$sample` chooses the document server-side, and then the id goes back through
 * the ordinary `findOne`, so the answer has been through decryption, the row
 * transform and relation loading exactly as any other read would. Returning the
 * sampled document directly would skip all three.
 *
 * @param host The repository being written through.
 * @param client The client, which supplies the session and the collection.
 * @returns The row, or null when the collection is empty.
 */
export async function mongoRandom(
  host: MongoRepositoryHost,
  client: DBClient,
): Promise<any> {
  const sampled = await client.mongoAggregate(host.table, [
    { $match: notDeletedFilter(host) },
    { $sample: { size: 1 } },
    { $project: { _id: 1 } },
  ]);
  if (!sampled.length) return null;
  return host.findOne(sampled[0]._id, {}, client);
}

/**
 * Empties a collection.
 *
 * `deleteMany` rather than `drop`: dropping takes the indexes and the validator
 * with it, so a truncated collection would silently stop enforcing the schema
 * and stop being unique where the model says it is. SQL's `DELETE FROM` leaves
 * both in place, which is the behaviour being matched.
 *
 * @param host The repository being written through.
 * @param client The client, which supplies the session and the collection.
 */
export async function mongoTruncate(
  host: MongoRepositoryHost,
  client: DBClient,
): Promise<void> {
  await client.mongoDeleteMany(host.table, {});
  await host.invalidateTableCache();
}

// ─── VERSIONING & HISTORY ─────────────────────────────────────────────

/**
 * The operations a history row records. Mirrors the union on `Repository`, and
 * is spelled out here rather than imported from it: `repository.ts` already
 * imports this file, and the storage layer's vocabulary is allowed to be its
 * own.
 */
export type MongoVersionOperation = "insert" | "update" | "delete";

/**
 * The compound `_id` a history document is keyed by.
 *
 * A row's history is one document per version, so the row's own key is not
 * unique within the collection — the same problem the link collection has, and
 * the same answer. `_id` uniqueness is the one constraint MongoDB enforces on
 * every collection without an index being declared, so keying a version by the
 * pair makes the version number the thing that cannot be stored twice.
 *
 * One function, so the shape the writer builds is the shape a reader matches.
 */
function historyId(
  host: MongoRepositoryHost,
  idValue: any,
  version: number,
): Record<string, any> {
  return { [host.idColumn]: idValue, version };
}

/**
 * Drops the compound `_id` off a history document.
 *
 * The identity is already on the row under its column name, which is where every
 * reader of a history row looks for it. Handing the `_id` back as well would put
 * a `{<id>, version}` object on an entity whose `id` is a scalar.
 */
function historyRow(row: any): any {
  if (!row || typeof row !== "object") return row ?? null;
  const { _id, ...rest } = row;
  return rest;
}

/**
 * Turns an entity into the history document a version is recorded as.
 *
 * The same treatment {@link buildMongoDocument} gives the live row — each column
 * under its column name, with {@link OMIT} dropping the keys an entity does not
 * carry — plus the audit fields the version is identified by. So a history row
 * is the row it recorded, with the window it was valid for attached, and the
 * relation loaders and row transforms that read column names work on it
 * unchanged.
 *
 * The primary key is written twice on purpose: into the compound `_id` that
 * makes the version unique, and under its own column name, because every read
 * path here — {@link mongoAsOf}, {@link mongoHistory}, {@link mongoRollback} —
 * addresses a history row by column name, and a dotted path into `_id` would be
 * the one place that did not.
 *
 * `valid_from` and `modified_at` are native `Date`s rather than the ISO strings
 * the SQL path binds: the "as of" window is a range query, and a string fails a
 * `{bsonType: "date"}` validator *and* compares lexically against a field the
 * index was built for as a date.
 *
 * `valid_to` is written only when there is one, and nothing writes one yet: it
 * is what an explicit close of a version would set, and until something does
 * that the newest row for a key is the open one. Writing a null says the same
 * thing at the cost of a field, and this backend's reads already treat an absent
 * field and a null one alike (`{valid_to: null}` matches both).
 *
 * @param host The repository the version belongs to.
 * @param entity The row as it now stands, or as it stood for a delete.
 * @param operation What the write did.
 * @param version The version number this row records.
 * @param user Who made the change, when the caller named someone.
 */
function buildHistoryDocument(
  host: MongoRepositoryHost,
  entity: Record<string, any>,
  operation: MongoVersionOperation,
  version: number,
  user?: string,
): Record<string, any> {
  const at = new Date();
  const idValue = entity?.[host.idProperty] ?? entity?.[host.idColumn];
  const document: Record<string, any> = {
    _id: historyId(host, idValue, version),
  };

  for (const [key, column] of Object.entries(host.columns)) {
    // Rows arrive from both directions: a hydrated read is keyed by column name,
    // and an entity a caller built is keyed by property. Both are read, so a
    // renamed column is recorded rather than stored as its absence.
    const sanitized = sanitizeMongoValue(
      entity?.[key] ?? entity?.[column.name],
    );
    if (sanitized === OMIT) continue;
    document[column.name] = sanitized;
  }

  // After the columns, so the history's own version is the one that lands when a
  // model declares a `version` column of its own. The two hold the same number
  // on every path through `writeHistory`, and the audit field is the one that
  // has to be right.
  document.operation = operation;
  document.version = version;
  document.valid_from = at;
  document.modified_by = user || "system";
  document.modified_at = at;

  return document;
}

/**
 * Appends one version of a row to its history collection.
 *
 * The one place that decides what a history row is, so the four paths that
 * record one — create, update, delete and rollback — cannot disagree about it.
 *
 * The version the history row is recorded under is not simply the version on the
 * entity it was handed. A delete carries the row's *current* version, which the
 * version it was created or last updated at already occupies — on SQL that is
 * two rows sharing a number, which nothing forbids and which leaves the audit
 * trail readable only by its `operation`. Here the version is half the compound
 * `_id`, so the same number twice is a duplicate-key error that fails the write
 * it was recording. A delete is a write like any other, and the number it is
 * recorded under is the next one.
 *
 * Counting past the newest *recorded* version rather than off the entity is what
 * keeps the three paths that already passed a fresh number on it: create sends
 * 1 against an empty history, update (and upsert) send the version the lock just
 * advanced to, and rollback sends one past the newest. Only a write that reuses
 * a number — the delete — moves.
 *
 * The read is taken inside whatever transaction the caller is in, so the number
 * is decided against the same snapshot as the write it accompanies, and a
 * retried transaction re-decides it rather than reusing a stale one.
 *
 * @param host The repository being written through.
 * @param entity The row as it now stands, or as it stood for a delete.
 * @param operation What the write did.
 * @param client The client, which supplies the session and the collection.
 * @param user Who made the change, when the caller named someone.
 */
export async function mongoWriteHistory(
  host: MongoRepositoryHost,
  entity: Record<string, any>,
  operation: MongoVersionOperation,
  client: DBClient,
  user?: string,
): Promise<void> {
  // `|| 1`, not `?? 1`: the SQL path counts the same way, and a version of zero
  // or an empty string is a row nobody recorded a version for.
  const sent = Number(entity?.version) || 1;
  const idValue = entity?.[host.idProperty] ?? entity?.[host.idColumn];
  const newest = await client.mongoFindOne(
    host.historyTable,
    { [host.idColumn]: idValue },
    { sort: { version: -1 }, projection: { version: 1 } },
  );
  const version = Math.max(sent, (Number(newest?.version) || 0) + 1);

  await client.mongoInsertOne(
    host.historyTable,
    buildHistoryDocument(host, entity, operation, version, user),
  );
}

/**
 * Reads the version of a row that was current at an instant.
 *
 * `{valid_to: null}` is the open window — a version whose end was never written,
 * or was written as an explicit null. Both are the same absence, and the pair
 * covers what the SQL path's `valid_to IS NULL OR valid_to > ?` covers.
 *
 * The sort is what stops a version that was never closed from coming back as an
 * arbitrary one: every version that started before the instant still matches the
 * open-window half of the filter, so without it the answer would be whichever
 * document the collection happened to hand over first.
 *
 * @param host The repository being read through.
 * @param id The row whose version is wanted.
 * @param asOfDate The instant to read the row as of.
 * @param client The client, which supplies the session and the collection.
 * @returns The version, or null when the row has no version covering the instant.
 */
export async function mongoAsOf(
  host: MongoRepositoryHost,
  id: number | string,
  asOfDate: Date | string,
  client: DBClient,
): Promise<any> {
  // Coerced rather than bound as given. A caller's ISO string compared against a
  // stored date is a comparison between BSON *types*, and MongoDB orders those by
  // kind before value — so every date would look older than every string and the
  // window would swallow versions that started after the instant.
  const at = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);

  const row = await client.mongoFindOne(
    host.historyTable,
    {
      [host.idColumn]: id,
      valid_from: { $lte: at },
      $or: [{ valid_to: null }, { valid_to: { $gt: at } }],
    },
    { sort: { version: -1 } },
  );

  return historyRow(row);
}

/**
 * Reads every version of a row, oldest first.
 *
 * Sorted rather than left to the server, because this is a *history*: a caller
 * reading it is reasoning about what happened in what order, and MongoDB gives
 * no order to a read that does not ask for one.
 *
 * @param host The repository being read through.
 * @param id The row whose history is wanted.
 * @param client The client, which supplies the session and the collection.
 */
export async function mongoHistory(
  host: MongoRepositoryHost,
  id: number | string,
  client: DBClient,
): Promise<any[]> {
  const rows = await client.mongoFind(
    host.historyTable,
    { [host.idColumn]: id },
    { sort: { version: 1 } },
  );
  return rows.map(historyRow);
}

/**
 * Restores a row to a version it used to hold, as a new version.
 *
 * The whole operation is one transaction, because it is three writes that only
 * mean anything together: the live document, the history row that records the
 * restore, and the read that returns what the caller just wrote.
 *
 * The new version is the one after the *newest* recorded version, not the one
 * after the version being restored. `version + 1` — what the SQL path writes —
 * names a version number that is usually already recorded when a caller rolls
 * back to anything but the latest version, and here the compound `_id` makes
 * that a duplicate-key error rather than a second row. Counting past the newest
 * both advances the version and leaves the versions in between in the audit
 * trail, which is the point of having one.
 *
 * The optimistic lock is the one column that is advanced rather than restored.
 * Everywhere else in this design a live row's version and the newest history
 * row's version are the same number — create, update and upsert all leave them
 * equal — and restoring the old one would hand a caller that had already written
 * it a version it could match on twice.
 *
 * @param host The repository being written through.
 * @param id The row to restore.
 * @param version The version to restore it to.
 * @param client The client, which supplies the session and the collection.
 * @returns The reloaded row, as the ordinary read path would return it.
 * @throws StabilizeError `ROLLBACK_ERROR` when the version or the row is gone.
 */
export async function mongoRollback(
  host: MongoRepositoryHost,
  id: number | string,
  version: number,
  client: DBClient,
): Promise<any> {
  const start = Date.now();
  host.logger.logDebug(`Rolling ${host.table} with ID ${id} back to version ${version}`);

  return client.transaction(async (tx) => {
    const target = await tx.mongoFindOne(host.historyTable, {
      [host.idColumn]: id,
      version,
    });
    if (!target) {
      throw new StabilizeError("Version not found", "ROLLBACK_ERROR");
    }

    // Read inside the same transaction as the write it decides, so two rollbacks
    // racing cannot both pick the same new version number.
    const newest = await tx.mongoFindOne(
      host.historyTable,
      { [host.idColumn]: id },
      { sort: { version: -1 }, projection: { version: 1 } },
    );
    const next =
      Math.max(Number(target.version) || 1, Number(newest?.version) || 0) + 1;

    // Every column the version recorded goes back onto the live document, keyed
    // by its column name. A column the version does not carry is cleared rather
    // than left alone: the row is being restored to a state, and a column that
    // state does not have is part of it.
    const restored: Record<string, any> = {};
    for (const [key, column] of Object.entries(host.columns)) {
      // The identity is never restored: a change of key is a delete and an
      // insert, which is why no other write path in this file touches `_id`.
      if (key === host.idProperty) continue;
      if (key === host.optimisticLockField) continue;
      const sanitized = sanitizeMongoValue(
        target[key] ?? target[column.name] ?? null,
      );
      restored[key] = sanitized === OMIT ? null : sanitized;
    }
    if (host.optimisticLockField) {
      restored[host.optimisticLockField] = next;
    }

    const { $set, $unset } = buildMongoPatch(host, restored);
    const operation = updateOperation($set, $unset);
    if (Object.keys(operation).length > 0) {
      const result = await tx.mongoUpdateOne(host.table, { _id: id }, operation);
      if (affectedRows(result, "matchedCount") === 0) {
        throw new StabilizeError("Not found", "ROLLBACK_ERROR");
      }
    }

    // The version this restore *creates* is the row as it was restored, recorded
    // like any other write. It is written after the live document, so a failure
    // between the two rolls both back rather than leaving a history row for a
    // state the row was never put into.
    await mongoWriteHistory(
      host,
      { ...target, version: next },
      "update",
      tx,
    );

    const reloaded = await host.findOne(id, {}, tx);
    await host.invalidateRowCache(id);
    await host.writeThroughRow(id, reloaded);

    host.logger.logDebug(
      `Rolled ${host.table} with ID ${id} back to version ${version} in ${Date.now() - start}ms`,
    );
    return reloaded;
  });
}

// ─── MANY-TO-MANY LINKS ───────────────────────────────────────────────

/**
 * Reads the links from `parentIds` outward, one chunk at a time.
 *
 * The projection is limited to the two key fields: the composite `_id` is a
 * duplicate of them, and a link collection has nothing else on it, so reading
 * whole documents would only move the same data twice.
 *
 * Sorted on `_id`, which is `{p, c}` — so a parent's children come back in
 * ascending child order, and the same read twice gives the same answer. A SQL
 * join table read with no `ORDER BY` has no order to match, and Mongo's is not
 * merely unspecified but liable to differ between two reads of unchanged data.
 *
 * @param client The client, which also supplies the transaction's session.
 * @param link The join collection and the two fields that name a link.
 * @param parentIds One chunk of parent ids, already deduplicated.
 */
export async function mongoFindLinks(
  client: DBClient,
  link: MongoLinkRelation,
  parentIds: (number | string)[],
): Promise<{ parent: any; child: any }[]> {
  if (parentIds.length === 0) return [];
  const { joinTable, foreignKey, inverseKey } = link;
  const docs = await client.mongoFind(
    joinTable,
    { [foreignKey]: { $in: parentIds } },
    {
      projection: { [foreignKey]: 1, [inverseKey]: 1 },
      sort: { _id: 1 },
    },
  );
  return docs.map((doc) => ({
    parent: doc[foreignKey],
    child: doc[inverseKey],
  }));
}

/**
 * The raw values linked to `id` through a many-to-many relation.
 *
 * Sorted for the same reason as {@link mongoFindLinks}: `attach` and `sync`
 * diff this list against what the caller asked for, and a list whose order
 * changes between calls would make those diffs look different when they are not.
 *
 * @param client The client, which also supplies the transaction's session.
 * @param link The join collection and the two fields that name a link.
 * @param id The parent whose links are wanted.
 */
export async function mongoFetchLinkedIds(
  client: DBClient,
  link: MongoLinkRelation,
  id: number | string,
): Promise<any[]> {
  const { joinTable, foreignKey, inverseKey } = link;
  const docs = await client.mongoFind(
    joinTable,
    { [foreignKey]: id },
    { projection: { [inverseKey]: 1 }, sort: { _id: 1 } },
  );
  return docs.map((doc) => doc[inverseKey]);
}

/**
 * Creates the links from `id` to each of `childIds`.
 *
 * Written as one upsert per pair rather than as a batch of inserts. The caller
 * has already read the existing links and filtered them out, so an insert would
 * normally succeed — but two callers can pass that check at the same time, and
 * the losing insert would fail the whole statement on the duplicate `_id`. An
 * upsert that matches an existing link simply changes nothing.
 *
 * @param client The client, which also supplies the transaction's session.
 * @param link The join collection and the two fields that name a link.
 * @param id The parent to link from.
 * @param childIds The children to link to, already deduplicated.
 */
export async function mongoAttachLinks(
  client: DBClient,
  link: MongoLinkRelation,
  id: number | string,
  childIds: (number | string)[],
): Promise<void> {
  if (childIds.length === 0) return;
  const { joinTable, foreignKey, inverseKey } = link;
  await client.mongoBulkWrite(
    joinTable,
    childIds.map((childId) => ({
      updateOne: {
        filter: { _id: linkId(id, childId) },
        update: {
          $setOnInsert: { [foreignKey]: id, [inverseKey]: childId },
        },
        upsert: true,
      },
    })),
  );
}

/**
 * Removes the links from `id`, or just those naming one of `childIds`.
 *
 * @param client The client, which also supplies the transaction's session.
 * @param link The join collection and the two fields that name a link.
 * @param id The parent to unlink from.
 * @param childIds The children to unlink, or `undefined` for all of them.
 * @returns how many links were removed.
 */
export async function mongoDetachLinks(
  client: DBClient,
  link: MongoLinkRelation,
  id: number | string,
  childIds?: (number | string)[],
): Promise<number> {
  const { joinTable, foreignKey, inverseKey } = link;
  const filter: Record<string, any> = { [foreignKey]: id };
  if (childIds !== undefined) {
    if (childIds.length === 0) return 0;
    filter[inverseKey] = { $in: childIds };
  }
  const result = await client.mongoDeleteMany(joinTable, filter);
  return affectedRows(result, "deletedCount");
}
