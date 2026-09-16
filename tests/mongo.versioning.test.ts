import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";
import { Repository } from "../repository";
import { decrypt } from "../utils/encryption";
import { MONGO_COUNTERS_COLLECTION } from "../mongo-repository";

/**
 * Versioning, encryption and caching, against a real MongoDB server.
 *
 * Versioning is the one feature this backend could not carry across by leaving
 * it alone: `asOf`, `history` and `rollback` are raw SQL statements on the
 * repository, and `writeHistory` builds an `INSERT`, so any model declared
 * `versioned: true` threw `MONGO_UNSUPPORTED` on its first `create()` — the
 * dispatch never existed. The cases below pin the three reads down to *values*
 * rather than to the absence of an error, because a versioning feature that
 * silently returns the wrong version is worse than one that throws: the older
 * title has to come back from `asOf`, `history` has to come back in order with
 * the operation that made each version, and `rollback` has to leave the row
 * holding the old value *and* a version that moved forward.
 *
 * Two things about this backend's history collection are load-bearing and are
 * asserted directly rather than inferred:
 *
 *   - a history document is keyed by **column name**, so a column declared with
 *     a `name:` mapping is recorded under that column name — every reader of a
 *     history row addresses it that way, and a rollback restores from it;
 *   - the validity window is a native `Date`, not the ISO string the SQL path
 *     binds. A string fails the collection's `{bsonType: "date"}` validator (one
 *     case below proves the server really rejects it) and would turn the window
 *     comparison into a comparison between BSON types.
 *
 * The suite skips itself when the replica set is not running, so `bun test`
 * stays green on a machine without the fleet:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 */

const REPLICA_SET_URL =
  process.env.MONGO_URL ||
  "mongodb://127.0.0.1:57017/stabilize_test?directConnection=true&replicaSet=rs0";

/** The driver import must stay inside the try. It is an optional dependency. */
async function hasReplicaSet(url: string): Promise<boolean> {
  let client: any = null;
  try {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(url, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    const hello = await client.db().admin().command({ hello: 1 });
    return Boolean(hello.setName);
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => {});
  }
}

const available = await hasReplicaSet(REPLICA_SET_URL);
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `[skip] No replica-set MongoDB at ${REPLICA_SET_URL}. ` +
      `Run: docker compose -f docker-compose.test.yml up --dry-run`,
  );
}

/** Lets two writes land in different milliseconds, which the windows need. */
const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

const Post = defineModel({
  tableName: "v7_posts",
  versioned: true,
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    // Renamed, deliberately. The property key and the column name differ, so a
    // history document written under either one can be told apart — and the
    // rollback below restores this column, which only works if the history row
    // carries it under the name the live document uses.
    subtitle: { type: DataTypes.STRING, name: "subtitle_col" },
    // The lock the versioning and the lock share: `writeHistory` records the
    // version number as the same field, and a rollback has to leave the live row
    // and the newest history row agreeing on it.
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
});

// The encrypted column is deliberately *not* renamed.
//
// `processForLoad` walks the property keys and reads `row[propertyKey]`, while a
// row arrives keyed by column name — so a column carrying both `encrypted: true`
// and a `name:` mapping is never decrypted on read, on any of the five backends.
// A model here with `ssn: { encrypted: true, name: "ssn_col" }` would fail the
// round-trip below and pin a bug this milestone is not the place to fix.
const Secret = defineModel({
  tableName: "v7_secrets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING },
    ssn: { type: DataTypes.STRING, encrypted: true },
  },
});

const HISTORY = "v7_posts_history";

/** Everything this file creates. The counters collection is *not* in here. */
const COLLECTIONS = ["v7_posts", HISTORY, "v7_secrets"];

/**
 * A cache that records what it was asked and keeps what it was given.
 *
 * The ORM's own cache is Redis-backed and this file must not require a Redis to
 * prove that a write reaches the cache and that a later read is served from it,
 * so the repository is handed one directly — the same shape
 * `tests/repository.cache-keys.test.ts` uses against a fake client, here over a
 * real one.
 */
class RecordingCache {
  public gets: string[] = [];
  public sets: { key: string; value: any }[] = [];
  public invalidated: string[] = [];
  public patterns: string[] = [];
  public store = new Map<string, any>();
  public config = { enabled: true, ttl: 60, strategy: "write-through" as const };

  getStrategy() {
    return this.config.strategy;
  }

  async get<T>(key: string): Promise<T | null> {
    this.gets.push(key);
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.sets.push({ key, value });
    this.store.set(key, value);
  }

  async invalidate(keys: string[]): Promise<void> {
    this.invalidated.push(...keys);
    for (const key of keys) this.store.delete(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    this.patterns.push(pattern);
    const prefix = pattern.replace(/\*$/, "");
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

/** One stored history row, oldest first. */
const storedHistory = (db: any, id: number) =>
  db.client.mongoFind(HISTORY, { id }, { sort: { version: 1 } });

const storedRow = (db: any, id: number) =>
  db.client.mongoFindOne("v7_posts", { _id: id });

suite("mongo versioning", () => {
  let db: any;

  const reset = async () => {
    for (const name of COLLECTIONS) {
      await db.client.mongoDeleteMany(name, {});
    }
    // Only this file's own counter documents. `stabilize_counters` is shared
    // with every other suite running beside this one, so dropping it would take
    // their counters — and their next generated id — with it.
    for (const table of ["v7_posts", "v7_secrets"]) {
      await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
        _id: table,
      });
    }
  };

  beforeAll(async () => {
    // Encrypted columns need a key; there is no hard-coded fallback.
    process.env.ORM_ENCRYPTION_KEY = "test-key-32-bytes-long-padding!!";
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    await reset();
    // `autoMigrate` is what creates the history collection, so a versioned model
    // that never migrates would fail on its first write rather than on its first
    // read. That it also installs the window's validator is proved below.
    await db.autoMigrate([Post, Secret]);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    await reset().catch(() => {});
    await db.close();
  });

  beforeEach(reset);

  // ─── the history collection ────────────────────────────────────────

  it("creates the history collection with its validator and indexes", async () => {
    const names = (await db.client.mongoListCollections()).map(
      (entry: any) => entry.name,
    );
    expect(names).toContain(HISTORY);

    const indexes = await db.client.mongoListIndexes(HISTORY);
    // The index the "as of" window ranges over. Without it the comparison still
    // answers correctly and stops being a one-row lookup.
    expect(
      indexes.some(
        (index: any) => index.key?.id === 1 && index.key?.valid_from === 1,
      ),
    ).toBe(true);
    expect(
      indexes.some(
        (index: any) => index.key?.id === 1 && index.key?.version === 1,
      ),
    ).toBe(true);
  });

  it("refuses a history row whose validity window is a string", async () => {
    // The SQL path binds `new Date().toISOString()`. Doing that here would fail
    // this validator (which is why `writeHistory` does not), and would have been
    // accepted silently by a collection with no validator — leaving an "as of"
    // range query comparing strings.
    let rejected = false;
    try {
      await db.client.mongoInsertOne(HISTORY, {
        _id: { id: 7001, version: 1 },
        id: 7001,
        title: "stringly typed",
        version: 1,
        operation: "insert",
        valid_from: new Date().toISOString(),
        modified_at: new Date().toISOString(),
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(await db.client.mongoCount(HISTORY, { id: 7001 })).toBe(0);
  });

  // ─── writing history ───────────────────────────────────────────────

  it("records a create as version 1, keyed by column name", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({
      title: "first",
      subtitle: "sub",
    });
    expect(created.id).toBe(1);

    const rows = await storedHistory(db, created.id);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row.operation).toBe("insert");
    expect(row.version).toBe(1);
    expect(row.title).toBe("first");
    // The renamed column, under its *column* name. A history document written
    // under the property key would be invisible to every reader of it.
    expect(row.subtitle_col).toBe("sub");
    expect(row.subtitle).toBeUndefined();
    expect(row.modified_by).toBe("system");

    // Native dates, both of them. @see the string case above.
    expect(row.valid_from).toBeInstanceOf(Date);
    expect(row.modified_at).toBeInstanceOf(Date);
    // The open window is an absent field, not a stored null — the same "absence
    // means null" shape every filter in this backend reads.
    expect("valid_to" in row).toBe(false);

    // The compound `_id` that makes one *version* unique when the row's own key
    // is not.
    expect(row._id).toEqual({ id: 1, version: 1 });
  });

  it("records every version a row goes through, in order", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({ title: "first", subtitle: "sub" });
    await repo.update(created.id, { title: "second", subtitle: "sub2" });
    await repo.update(created.id, { title: "third", subtitle: "sub3" });

    const history: any[] = await repo.history(created.id);

    expect(history).toHaveLength(3);
    expect(history.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(history.map((row) => row.operation)).toEqual([
      "insert",
      "update",
      "update",
    ]);
    expect(history.map((row) => row.title)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(history.map((row) => row.subtitle_col)).toEqual([
      "sub",
      "sub2",
      "sub3",
    ]);

    // Ascending, and not merely by accident: a history read that does not ask
    // for an order has none to give.
    expect(history[0].valid_from.getTime()).toBeLessThanOrEqual(
      history[1].valid_from.getTime(),
    );
    expect(history[1].valid_from.getTime()).toBeLessThanOrEqual(
      history[2].valid_from.getTime(),
    );
    // The identity is a field on the row, not the compound `_id` object.
    expect(history.map((row) => row.id)).toEqual([1, 1, 1]);
    expect(history[0]._id).toBeUndefined();
  });

  it("returns an empty history for a row that has none", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.history(4242)).toEqual([]);
  });

  it("records a delete as its own version", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({ title: "doomed" });
    await repo.delete(created.id);

    const history: any[] = await repo.history(created.id);
    // Its own version, not a second row under the version the insert recorded.
    // The compound key makes the reuse a duplicate-key error rather than a
    // second row, so the delete has to be recorded as the next version.
    expect(history.map((row) => row.version)).toEqual([1, 2]);
    expect(history.map((row) => row.operation)).toEqual(["insert", "delete"]);
    expect(history[1].title).toBe("doomed");
    expect(history[0].operation).toBe("insert");
    expect(await storedRow(db, created.id)).toBeNull();
  });

  // ─── asOf ──────────────────────────────────────────────────────────

  it("returns the version that was current at the instant asked for", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({ title: "first", subtitle: "sub" });

    // The instant between the two writes. The clock is coarse enough that a
    // same-millisecond update would land inside the window and make this
    // ambiguous, so the writes are separated rather than raced.
    await tick();
    const between = new Date();
    await tick();

    await repo.update(created.id, { title: "second", subtitle: "sub2" });

    const then: any = await repo.asOf(created.id, between);
    expect(then.title).toBe("first");
    expect(then.subtitle_col).toBe("sub");
    expect(then.version).toBe(1);

    const now: any = await repo.asOf(created.id, new Date());
    expect(now.title).toBe("second");
    expect(now.version).toBe(2);

    // Before the row existed there is no version to return — not the oldest one,
    // which is what a filter that had lost its lower bound would hand back.
    expect(await repo.asOf(created.id, new Date(0))).toBeNull();
    expect(await repo.asOf(999, new Date())).toBeNull();
  });

  it("accepts an ISO string for the instant, rather than comparing types", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({ title: "first" });
    await tick();
    const between = new Date().toISOString();
    await tick();
    await repo.update(created.id, { title: "second" });

    // A string compared against a stored date is a comparison between BSON
    // *types*, which MongoDB orders by kind before value — every date would look
    // older than every string, and the window would match the newest version for
    // any instant. `asOf` is typed as taking a `Date`; the coercion is what the
    // SQL path's ISO-string binding needs replacing, so it is asserted rather
    // than assumed.
    const then: any = await repo.asOf(created.id, between as any);
    expect(then.title).toBe("first");
  });

  // ─── rollback ──────────────────────────────────────────────────────

  it("restores a version's values and advances the version", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({ title: "first", subtitle: "sub" });
    await repo.update(created.id, { title: "second", subtitle: "sub2" });
    const third: any = await repo.update(created.id, {
      title: "third",
      subtitle: "sub3",
    });
    expect(third.version).toBe(3);

    const restored: any = await repo.rollback(created.id, 1);

    // The old values, every column of them — the renamed one included, which is
    // only reachable because the history row is keyed by column name.
    expect(restored.title).toBe("first");
    expect(restored.subtitle_col).toBe("sub");
    // And the version moved *forward*: past the newest version recorded, which
    // is what makes the restore a version of its own rather than a rewind.
    expect(restored.version).toBe(4);

    // Asserted against the collection too, not just against what the call
    // returned.
    const raw = await storedRow(db, created.id);
    expect(raw.title).toBe("first");
    expect(raw.subtitle_col).toBe("sub");
    expect(raw.version).toBe(4);

    const history: any[] = await repo.history(created.id);
    expect(history.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(new Set(history.map((row) => row.version)).size).toBe(4);
    expect(history.map((row) => row.title)).toEqual([
      "first",
      "second",
      "third",
      "first",
    ]);
    expect(history[3].operation).toBe("update");
    // The audit of what was rolled *over* survives: version 3 still records
    // "third".
    expect(history[2].title).toBe("third");

    // The next ordinary write carries on from the advanced version rather than
    // colliding with it.
    const next: any = await repo.update(created.id, { title: "fourth" });
    expect(next.version).toBe(5);
    expect((await repo.history(created.id)).at(-1).version).toBe(5);
  });

  it("clears a column the restored version never had", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({ title: "bare" });
    await repo.update(created.id, { subtitle: "added" });
    expect((await storedRow(db, created.id)).subtitle_col).toBe("added");

    await repo.rollback(created.id, 1);

    // The row is restored to a *state*, and a column that state does not have is
    // part of it — leaving the later value in place would restore the version's
    // title and keep someone else's subtitle.
    expect("subtitle_col" in (await storedRow(db, created.id))).toBe(false);
  });

  it("reports a version it has never recorded", async () => {
    const repo = db.getRepository(Post);
    const created: any = await repo.create({ title: "only" });

    // try/catch rather than `.rejects`: a rejection assertion that never settles
    // leaves Bun's runner hanging.
    let code = "";
    let message = "";
    try {
      await repo.rollback(created.id, 99);
    } catch (error) {
      code = (error as any).code;
      message = (error as Error).message;
    }

    expect(code).toBe("ROLLBACK_ERROR");
    expect(message).toBe("Version not found");
    // Nothing was written: the row still holds what it held.
    const raw = await storedRow(db, created.id);
    expect(raw.title).toBe("only");
    expect(raw.version).toBe(1);
    expect(await repo.history(created.id)).toHaveLength(1);
  });

  it("refuses the three reads on a model that is not versioned", async () => {
    // The guard sits above the dispatch, so a MongoDB model reaches the same
    // error every other backend raises rather than a query with no history
    // collection behind it.
    const repo = db.getRepository(Secret);
    const codes: string[] = [];
    for (const call of [
      () => repo.asOf(1, new Date()),
      () => repo.history(1),
      () => repo.rollback(1, 1),
    ]) {
      try {
        await call();
      } catch (error) {
        codes.push((error as any).code);
      }
    }
    expect(codes).toEqual([
      "VERSIONING_ERROR",
      "VERSIONING_ERROR",
      "VERSIONING_ERROR",
    ]);
  });

  // ─── encryption ────────────────────────────────────────────────────

  it("round-trips an encrypted column through create and read-back", async () => {
    const repo = db.getRepository(Secret);
    const created: any = await repo.create({
      label: "employee",
      ssn: "123-45-6789",
    });

    // The stored bytes are ciphertext...
    const raw = await db.client.mongoFindOne("v7_secrets", { _id: created.id });
    expect(raw.ssn).not.toBe("123-45-6789");
    expect(decrypt(raw.ssn)).toBe("123-45-6789");

    // ...and every read of it is plaintext, through the read-back `create`
    // returns, through `findOne`, and through the query builder.
    expect(created.ssn).toBe("123-45-6789");
    expect((await repo.findOne(created.id))?.ssn).toBe("123-45-6789");
    expect(
      (await repo.find().whereEq("v7_secrets.id", created.id).execute(db.client))[0]
        .ssn,
    ).toBe("123-45-6789");

    // A failed decrypt is raised rather than turned into a null the caller
    // cannot tell from an empty field.
    await db.client.mongoUpdateOne(
      "v7_secrets",
      { _id: created.id },
      { $set: { ssn: "not-ciphertext" } },
    );
    let code = "";
    try {
      await repo.findOne(created.id);
    } catch (error) {
      code = (error as any).code;
    }
    expect(code).toBe("DECRYPTION_ERROR");
  });

  it("updates an encrypted column without losing the previous ciphertext", async () => {
    const repo = db.getRepository(Secret);
    const created: any = await repo.create({ label: "x", ssn: "111-11-1111" });

    const updated: any = await repo.update(created.id, { ssn: "222-22-2222" });

    expect(updated.ssn).toBe("222-22-2222");
    const raw = await db.client.mongoFindOne("v7_secrets", { _id: created.id });
    expect(decrypt(raw.ssn)).toBe("222-22-2222");
  });

  // ─── cache ─────────────────────────────────────────────────────────

  it("writes a created row through to the cache and serves it back", async () => {
    const cache = new RecordingCache();
    const repo: any = new Repository<any>(
      db.client,
      Post,
      cache.config as any,
      undefined,
      cache as any,
    );

    const created: any = await repo.create({ title: "cached", subtitle: "s" });
    const key = `findOne:v7_posts:${created.id}`;

    // Write-through: the row the caller was handed is the row the cache holds,
    // so a read that hits the cache gets a decrypted row rather than ciphertext
    // or a raw column set.
    expect(cache.store.get(key)?.[0]?.title).toBe("cached");
    expect(cache.store.get(key)?.[0]?.subtitle_col).toBe("s");

    // Proves the cache was *consulted*: the row behind it is changed, and the
    // read still answers with what was cached.
    await db.client.mongoUpdateOne(
      "v7_posts",
      { _id: created.id },
      { $set: { title: "behind-the-cache" } },
    );
    expect((await repo.findOne(created.id)).title).toBe("cached");
    expect(cache.gets).toContain(key);
  });

  it("does not leave a stale cached row behind an update or a delete", async () => {
    const cache = new RecordingCache();
    const repo: any = new Repository<any>(
      db.client,
      Post,
      cache.config as any,
      undefined,
      cache as any,
    );
    const created: any = await repo.create({ title: "first" });
    const key = `findOne:v7_posts:${created.id}`;

    await repo.update(created.id, { title: "second" });

    // The update both invalidates the cached row and writes the new one through,
    // so the next read is the new value by either route.
    expect(cache.invalidated).toContain(key);
    expect(cache.store.get(key)?.[0]?.title).toBe("second");
    expect((await repo.findOne(created.id)).title).toBe("second");

    await repo.delete(created.id);

    expect(cache.store.get(key)).toBeUndefined();
    expect(await repo.findOne(created.id)).toBeNull();
  });

  it("leaves the cache holding the row a rollback restored", async () => {
    const cache = new RecordingCache();
    const repo: any = new Repository<any>(
      db.client,
      Post,
      cache.config as any,
      undefined,
      cache as any,
    );
    const created: any = await repo.create({ title: "first", subtitle: "sub" });
    const key = `findOne:v7_posts:${created.id}`;
    await repo.update(created.id, { title: "second" });
    expect(cache.store.get(key)?.[0]?.title).toBe("second");

    await repo.rollback(created.id, 1);

    // A rollback writes the live document, so a cached row that survived it
    // would serve the pre-rollback value to every later read.
    expect(cache.store.get(key)?.[0]?.title).toBe("first");
    expect(cache.store.get(key)?.[0]?.version).toBe(3);
    expect((await repo.findOne(created.id)).title).toBe("first");
  });
});
