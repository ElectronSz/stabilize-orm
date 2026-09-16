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
import { OMIT, normalizeMongoDoc, sanitizeMongoValue } from "./mongo-query";

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
  logger: { logDebug(message: string): void };
  /** Throws when the entity fails the model's validators. */
  validate(entity: any): void;
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
