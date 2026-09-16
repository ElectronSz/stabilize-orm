import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";
import { decrypt } from "../utils/encryption";
import { MONGO_COUNTERS_COLLECTION } from "../mongo-repository";

/**
 * The write paths, against a real MongoDB server.
 *
 * The SQL cases this mirrors (`integration.write-paths.test.ts`) each pinned a
 * bug that a fake client could not expose. Re-running them here is what proves
 * the MongoDB bodies preserve those fixes rather than re-introducing them in a
 * second dialect: hooks still run above the dispatch, `bulkCreate` still writes
 * every column of a batch, and `upsert` still resolves the row it actually
 * wrote instead of a value that describes an unrelated statement.
 *
 * The assertions on stored bytes go through `mongoFind`/`mongoFindOne` rather
 * than `client.query`, because there is no SQL to send and `query()` refuses
 * outright on this backend.
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
      `Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

/** Records every hook invocation so the tests can assert on ordering. */
const calls: string[] = [];

const Doc = defineModel({
  tableName: "w5_docs",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    // Deliberately required and deliberately never supplied by the caller: the
    // `beforeCreate` hook is what fills it in.
    slug: { type: DataTypes.STRING, required: true },
    tag: { type: DataTypes.STRING },
  },
  hooks: {
    beforeCreate: (entity: any) => {
      entity.slug = String(entity.title).toLowerCase().replace(/\s+/g, "-");
    },
    afterCreate: (entity: any) => {
      calls.push(`afterCreate:${entity.id}`);
    },
    beforeUpdate: (entity: any) => {
      calls.push(`beforeUpdate:${entity.id}`);
      entity.tag = `${entity.tag}-touched`;
    },
    afterSave: (entity: any) => {
      calls.push(`afterSave:${entity.id}`);
    },
    beforeDelete: (entity: any) => {
      calls.push(`beforeDelete:${entity.id}`);
    },
    afterDelete: (entity: any) => {
      calls.push(`afterDelete:${entity.id}`);
    },
  },
});

// A hook declared as a class method rather than in the config. It only resolves
// on a real model instance, which is what `hydrate` provides.
(Doc.prototype as any).afterUpdate = function () {
  calls.push(`methodAfterUpdate:${this.id}`);
};

const Account = defineModel({
  tableName: "w5_accounts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    email: { type: DataTypes.STRING, unique: true },
    name: { type: DataTypes.STRING },
    nickname: { type: DataTypes.STRING },
  },
});

const Secret = defineModel({
  tableName: "w5_secrets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING },
    ssn: { type: DataTypes.STRING, encrypted: true },
  },
});

/** Timestamps, an optimistic lock and both bulk operations. */
const Note = defineModel({
  tableName: "w5_notes",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    body: { type: DataTypes.STRING },
    rev: { type: DataTypes.INTEGER, optimisticLock: true },
    createdAt: { type: DataTypes.DATETIME },
    updatedAt: { type: DataTypes.DATETIME },
  },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
});

const COLLECTIONS = [
  "w5_docs",
  "w5_accounts",
  "w5_secrets",
  "w5_notes",
  "w5_tasks",
  MONGO_COUNTERS_COLLECTION,
];

const dropAll = async (db: any) => {
  // Dropped rather than emptied: the counters and the indexes are what make
  // `id === 1` and the unique-email assertions mean anything, and both survive
  // a `deleteMany`.
  for (const name of COLLECTIONS) {
    await db.client.mongoCommand({ drop: name }).catch(() => {});
  }
};

describe("mongo write paths", () => {
  let db: any;

  beforeAll(async () => {
    // Encrypted columns need a key; there is no hard-coded fallback.
    process.env.ORM_ENCRYPTION_KEY = "test-key-32-bytes-long-padding!!";
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    await dropAll(db);
    await db.autoMigrate([Doc, Account, Secret, Note]);
  });

  afterAll(async () => {
    if (!db) return;
    await dropAll(db).catch(() => {});
    await db.close();
  });

  // ─── hooks ─────────────────────────────────────────────────────────

  it("persists what a beforeCreate hook wrote", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "Hello World" });

    // The hook supplied `slug`, which is required — validation runs after the
    // hooks, so the insert succeeds and the value is actually written.
    expect(created.slug).toBe("hello-world");
    expect((await repo.findOne(created.id))?.slug).toBe("hello-world");

    const raw = await db.client.mongoFindOne("w5_docs", { _id: created.id });
    expect(raw.slug).toBe("hello-world");
  });

  it("runs afterCreate and afterSave with the created entity", async () => {
    const repo = db.getRepository(Doc);
    calls.length = 0;

    const created: any = await repo.create({ title: "Second" });

    expect(calls).toContain(`afterCreate:${created.id}`);
    expect(calls).toContain(`afterSave:${created.id}`);
  });

  it("runs beforeUpdate, the class-method afterUpdate and afterSave on update", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "Third", tag: "x" });
    calls.length = 0;

    const updated: any = await repo.update(created.id, { title: "Third!" });

    expect(calls).toContain(`beforeUpdate:${created.id}`);
    expect(calls).toContain(`afterSave:${created.id}`);
    expect(calls).toContain(`methodAfterUpdate:${created.id}`);
    // The beforeUpdate mutation has to reach the database.
    expect(updated.tag).toBe("x-touched");
    const raw = await db.client.mongoFindOne("w5_docs", { _id: created.id });
    expect(raw.tag).toBe("x-touched");
  });

  it("runs the delete hooks", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "Fourth" });
    calls.length = 0;

    await repo.delete(created.id);

    expect(calls).toContain(`beforeDelete:${created.id}`);
    expect(calls).toContain(`afterDelete:${created.id}`);
    expect(await db.client.mongoFindOne("w5_docs", { _id: created.id })).toBeNull();
  });

  // ─── bulk create ───────────────────────────────────────────────────

  it("writes every column of a bulk batch, not just the first row's", async () => {
    const repo = db.getRepository(Doc);
    calls.length = 0;

    const created = await repo.bulkCreate([
      { title: "narrow", slug: "narrow" },
      { title: "wide", slug: "wide", tag: "kept" },
    ]);

    // The second row carries a column the first does not. Documents being
    // independent makes this free here, but the SQL path had to union the key
    // sets, and dropping that union is exactly how the bug would come back.
    const wide = created.find((doc: any) => doc.title === "wide");
    expect(wide?.tag).toBe("kept");

    const raw = await db.client.mongoFindOne("w5_docs", { title: "wide" });
    expect(raw.tag).toBe("kept");
    expect("tag" in (await db.client.mongoFindOne("w5_docs", { title: "narrow" }))).toBe(
      false,
    );
  });

  it("returns the rows a bulk insert actually created", async () => {
    const repo = db.getRepository(Doc);
    const created = await repo.bulkCreate([
      { title: "a1", slug: "a1" },
      { title: "a2", slug: "a2" },
      { title: "a3", slug: "a3" },
    ]);

    expect(created).toHaveLength(3);
    expect(created.map((doc: any) => doc.title)).toEqual(["a1", "a2", "a3"]);

    // Every returned id must be a row that holds the matching value. On SQL
    // this needed `ORDER BY id DESC LIMIT n` to be replaced by something that
    // actually named the rows; here the ids are allocated up front, so the
    // assertion is that the allocation and the documents agree.
    for (const doc of created) {
      const raw = await db.client.mongoFindOne("w5_docs", { _id: doc.id });
      expect(raw.title).toBe(doc.title);
    }
  });

  // ─── upsert ────────────────────────────────────────────────────────

  it("returns the row an upsert actually wrote", async () => {
    const repo = db.getRepository(Account);
    const first: any = await repo.upsert(
      { email: "a@example.com", name: "first" },
      ["email"],
    );

    // An unrelated insert, which is what moved the connection's
    // last-inserted-rowid on the SQL path.
    await repo.create({ email: "b@example.com", name: "other" });

    const upserted: any = await repo.upsert(
      { email: "a@example.com", name: "second" },
      ["email"],
    );

    expect(upserted.id).toBe(first.id);
    expect(upserted.name).toBe("second");
    expect(upserted.email).toBe("a@example.com");

    const other = await repo.findOneBy({ email: "b@example.com" });
    expect(other?.name).toBe("other");
  });

  it("treats an upsert onto an existing key as an update", async () => {
    const repo = db.getRepository(Account);
    await repo.upsert({ email: "c@example.com", name: "one" }, ["email"]);
    const before = await repo.count();

    const second: any = await repo.upsert(
      { email: "c@example.com", name: "two" },
      ["email"],
    );

    expect(await repo.count()).toBe(before);
    expect(second.name).toBe("two");
    expect(await repo.find().execute(db.client)).toHaveLength(before);
  });

  it("encrypts a column written through bulkCreate", async () => {
    const repo = db.getRepository(Secret);
    await repo.bulkCreate([
      { label: "one", ssn: "111-11-1111" },
      { label: "two", ssn: "222-22-2222" },
    ]);

    const raw = await db.client.mongoFind("w5_secrets", {}, { sort: { _id: 1 } });
    expect(raw[0].ssn).not.toBe("111-11-1111");
    expect(decrypt(raw[0].ssn)).toBe("111-11-1111");
    expect(decrypt(raw[1].ssn)).toBe("222-22-2222");
  });
});

describe("mongo bulk operation guards", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    await dropAll(db);
    await db.autoMigrate([Note]);
  });

  afterAll(async () => {
    if (!db) return;
    await dropAll(db).catch(() => {});
    await db.close();
  });

  it("advances updatedAt on updateBy", async () => {
    const repo = db.getRepository(Note);
    const created: any = await repo.create({ title: "one", body: "x" });

    // The clock is coarse enough that a same-millisecond write is possible.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const affected = await repo.updateBy({ title: "one" }, { body: "y" });

    expect(affected).toBe(1);
    const after: any = await repo.findOne(created.id);
    expect(after.body).toBe("y");
    expect(after.updatedAt).toBeTruthy();
    expect(after.updatedAt).not.toBe(created.updatedAt);
  });

  it("advances the optimistic lock on updateBy", async () => {
    const repo = db.getRepository(Note);
    const created: any = await repo.create({ title: "locked-here" });

    await repo.updateBy({ title: "locked-here" }, { body: "z" });

    const after: any = await repo.findOne(created.id);
    expect(after.rev).toBe(2);

    // The row must still be writable: a stale version would reject this.
    const updated: any = await repo.update(created.id, { body: "z2" });
    expect(updated.rev).toBe(3);
  });

  it("reports a genuine optimistic-lock conflict", async () => {
    // The other half of the lock: matching on the version is only meaningful if
    // a stale version is actually refused.
    const repo = db.getRepository(Note);
    const created: any = await repo.create({ title: "contested" });
    expect(created.rev).toBe(1);

    let caught: any = null;
    try {
      // The version the caller read, after someone else has already moved it.
      await repo.update(created.id, { body: "stale", rev: 1 } as any);
      await repo.update(created.id, { body: "staler", rev: 1 } as any);
    } catch (error) {
      caught = error;
    }

    expect(caught?.code).toBe("CONCURRENT_MODIFICATION");
    expect((await repo.findOne(created.id))?.body).toBe("stale");
  });

  it("refuses updateBy with no conditions", async () => {
    const repo = db.getRepository(Note);
    await repo.create({ title: "survivor" });
    const before = await repo.count();

    // try/catch rather than `.rejects`: a rejection assertion that never
    // settles leaves Bun's runner hanging.
    let message = "";
    try {
      await repo.updateBy({}, { body: "wiped" });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/at least one condition/i);
    expect(await repo.count()).toBe(before);
    expect(await repo.find().execute(db.client)).toHaveLength(before);
  });

  it("refuses deleteBy with no conditions", async () => {
    const repo = db.getRepository(Note);
    const before = await repo.count();

    let message = "";
    try {
      await repo.deleteBy({});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/at least one condition/i);
    expect(await repo.count()).toBe(before);
  });

  it("deletes only the rows deleteBy matches", async () => {
    const repo = db.getRepository(Note);
    await repo.create({ title: "delete-me" });
    await repo.create({ title: "keep-me" });
    const before = await repo.count();

    const affected = await repo.deleteBy({ title: "delete-me" });

    expect(affected).toBe(1);
    expect(await repo.count()).toBe(before - 1);
    expect(await repo.exists({ title: "keep-me" })).toBe(true);
  });
});

/**
 * The soft-deleting model for the operations below.
 *
 * `deleted_at` carries the flag, and the two columns exist to give the
 * column-level operations something with a shape of its own: `done` is a
 * boolean, which this backend stores as a boolean rather than as 1/0, and
 * `status` is the column the "clear it" case unsets.
 */
const Task = defineModel({
  tableName: "w5_tasks",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true, index: "idx_w5_task_title" },
    status: { type: DataTypes.STRING },
    done: { type: DataTypes.BOOLEAN },
    views: { type: DataTypes.INTEGER },
    score: { type: DataTypes.INTEGER },
    deleted_at: { type: DataTypes.DATETIME, softDelete: true },
  },
});

/**
 * The column-level and set-level write operations, which the ported suite above
 * does not reach.
 *
 * A silently-wrong filter is the failure mode this backend is most exposed to:
 * it returns the wrong rows and reports no error, so nothing downstream is in a
 * position to notice. These cases each pin a filter down to one row or to an
 * exact count for that reason.
 */
describe("mongo write operations", () => {
  let db: any;

  /** Each case starts from an empty collection and a counter back at zero. */
  const reset = async () => {
    await db.client.mongoDeleteMany("w5_tasks", {});
    await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
      _id: "w5_tasks",
    });
  };

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    await dropAll(db);
    await db.autoMigrate([Task]);
  });

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    await dropAll(db).catch(() => {});
    await db.close();
  });

  // ─── soft delete ───────────────────────────────────────────────────

  it("soft deletes, hides the row, and recovers it", async () => {
    const repo = db.getRepository(Task);
    const created: any = await repo.create({ title: "soft" });

    await repo.delete(created.id);

    expect(await repo.findOne(created.id)).toBeNull();
    expect(
      (await repo.findDeleted().execute(db.client)).some(
        (row: any) => row.id === created.id,
      ),
    ).toBe(true);

    // Deleted, not removed: the document is still there, carrying the stamp.
    const raw = await db.client.mongoFindOne("w5_tasks", { _id: created.id });
    expect(raw).not.toBeNull();
    expect(raw.deleted_at).toBeInstanceOf(Date);

    await repo.recover(created.id);
    expect((await repo.findOne(created.id))?.title).toBe("soft");

    // `$unset`, not a stored null — the same "absent means not deleted" shape
    // every other filter in this backend reads.
    const recovered = await db.client.mongoFindOne("w5_tasks", {
      _id: created.id,
    });
    expect("deleted_at" in recovered).toBe(false);
  });

  it("bulk deletes softly and leaves the rows in place", async () => {
    const repo = db.getRepository(Task);
    const first: any = await repo.create({ title: "b1" });
    const second: any = await repo.create({ title: "b2" });

    await repo.bulkDelete([first.id, second.id]);

    expect(await repo.count()).toBe(0);
    expect(await db.client.mongoCount("w5_tasks", {})).toBe(2);
  });

  it("restores by condition and refuses to touch anything else", async () => {
    const repo = db.getRepository(Task);
    const kept: any = await repo.create({ title: "kept" });
    const restored: any = await repo.create({ title: "restored" });
    await repo.delete(kept.id);
    await repo.delete(restored.id);

    const affected = await repo.restoreBy({ title: "restored" });

    expect(affected).toBe(1);
    expect((await repo.findOne(restored.id))?.title).toBe("restored");
    expect(await repo.findOne(kept.id)).toBeNull();
  });

  // ─── column-level operations ───────────────────────────────────────

  it("clears a column when a patch passes null", async () => {
    const repo = db.getRepository(Task);
    const created: any = await repo.create({ title: "cleared", status: "open" });
    expect(
      (await db.client.mongoFindOne("w5_tasks", { _id: created.id })).status,
    ).toBe("open");

    await repo.update(created.id, { status: null } as any);

    // SQL spells this `SET status = NULL`. A document store spells it `$unset`,
    // and dropping the key from the patch instead would have left "open" in
    // place while reporting success.
    const raw = await db.client.mongoFindOne("w5_tasks", { _id: created.id });
    expect("status" in raw).toBe(false);
    expect((await repo.findOne(created.id))?.status ?? null).toBeNull();
  });

  it("stores a boolean as a boolean, not as 1 and 0", async () => {
    const repo = db.getRepository(Task);
    const created: any = await repo.create({ title: "typed", done: true });

    await repo.update(created.id, { done: false } as any);

    // Every SQL backend coerces a boolean to 1|0, and reusing that coercion
    // here would fail a `{bsonType: "bool"}` validator and make
    // `whereEq("done", true)` match nothing — a read that answers "no rows"
    // for rows that are plainly there.
    const raw = await db.client.mongoFindOne("w5_tasks", { _id: created.id });
    expect(raw.done).toBe(false);
  });

  it("toggles a boolean in place", async () => {
    const repo = db.getRepository(Task);
    const created: any = await repo.create({ title: "toggled", done: false });

    const on: any = await repo.toggle(created.id, "done");
    expect(on.done).toBe(true);
    const off: any = await repo.toggle(created.id, "done");
    expect(off.done).toBe(false);

    // The round trip through the driver, not just the value handed back.
    expect(
      (await db.client.mongoFindOne("w5_tasks", { _id: created.id })).done,
    ).toBe(false);
  });

  it("increments and decrements a counter column", async () => {
    const repo = db.getRepository(Task);
    const created: any = await repo.create({ title: "counted", views: 5 });

    expect((await repo.increment(created.id, "views", 3)).views).toBe(8);
    expect((await repo.decrement(created.id, "views", 2)).views).toBe(6);
  });

  it("will not increment a soft-deleted row", async () => {
    // The filter the SQL path carries as `AND deleted_at IS NULL`. Dropping it
    // would let a write reach a row every read says is gone.
    const repo = db.getRepository(Task);
    const created: any = await repo.create({ title: "gone", views: 1 });
    await repo.delete(created.id);

    await repo.increment(created.id, "views", 10);

    const raw = await db.client.mongoFindOne("w5_tasks", { _id: created.id });
    expect(raw.views).toBe(1);
  });

  // ─── set-level reads and writes ────────────────────────────────────

  it("aggregates over the collection", async () => {
    const repo = db.getRepository(Task);
    await repo.create({ title: "a", score: 10 });
    await repo.create({ title: "b", score: 20 });

    const aggregated = await repo.aggregate({
      count: "*",
      sum: ["score"],
      avg: ["score"],
      min: ["score"],
      max: ["score"],
    });

    // Same aliases the SQL path produces: the caller reads the answer out of
    // these names, so they are part of the contract rather than a detail.
    expect(aggregated.count_all).toBe(2);
    expect(aggregated.sum_score).toBe(30);
    expect(aggregated.avg_score).toBe(15);
    expect(aggregated.min_score).toBe(10);
    expect(aggregated.max_score).toBe(20);
  });

  it("aggregates an empty collection into zeroes rather than nothing", async () => {
    const aggregated = await db.getRepository(Task).aggregate({
      count: "*",
      sum: ["score"],
    });

    // `$group` over an empty input produces no documents at all, where SQL's
    // aggregate query still returns one row. Reporting `undefined` for the
    // count of nothing would make `count_all + 1` come out `NaN` — on the one
    // input a fresh install always has.
    expect(aggregated.count_all).toBe(0);
    expect(aggregated.sum_score).toBeNull();
  });

  it("aggregates nothing into an empty object", async () => {
    expect(await db.getRepository(Task).aggregate({})).toEqual({});
  });

  it("counts distinct values, skipping the ones that are null", async () => {
    const repo = db.getRepository(Task);
    await repo.create({ title: "d1", status: "open" });
    await repo.create({ title: "d2", status: "open" });
    await repo.create({ title: "d3", status: "closed" });
    await repo.create({ title: "d4" }); // no status at all

    expect(await repo.countDistinct("status")).toBe(2);

    // SQL's `COUNT(DISTINCT …)` counts values, and a stored null is not one.
    // Mongo's `distinct` hands it back like any other value, so this count
    // would be 2 — one too many — without the explicit filter. Written raw
    // because the write path never stores a null: it unsets the key instead.
    await db.client.mongoInsertOne("w5_tasks", {
      _id: 900,
      title: "raw",
      loose: null,
    });
    await db.client.mongoInsertOne("w5_tasks", {
      _id: 901,
      title: "raw",
      loose: 7,
    });

    expect(await repo.countDistinct("loose")).toBe(1);
  });

  it("paginates with a total that excludes soft-deleted rows", async () => {
    const repo = db.getRepository(Task);
    await repo.create({ title: "p1" });
    await repo.create({ title: "p2" });
    await repo.create({ title: "p3" });
    const gone: any = await repo.create({ title: "p4" });
    await repo.delete(gone.id);

    const page = await repo.paginate(1, 2);

    // The count and the page have to agree on what a row is. A `COUNT(*)`
    // that forgot the soft-delete clause would report 4 here.
    expect(page.total).toBe(3);
    expect(page.data).toHaveLength(2);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(2);
  });

  it("returns a row at random, and null when there are none", async () => {
    const repo = db.getRepository(Task);
    expect(await repo.random()).toBeNull();

    const only: any = await repo.create({ title: "only" });
    const picked: any = await repo.random();
    expect(picked?.id).toBe(only.id);
    expect(picked?.title).toBe("only");
  });

  it("pages through a cursor", async () => {
    const repo = db.getRepository(Task);
    await repo.create({ title: "c1" });
    await repo.create({ title: "c2" });
    await repo.create({ title: "c3" });

    const first = await repo.findMany({
      orderBy: { field: "id", direction: "ASC" },
      take: 2,
    });
    expect(first.map((row: any) => row.id)).toEqual([1, 2]);

    const next = await repo.findMany({
      cursor: { field: "id", value: first[1].id },
      orderBy: { field: "id", direction: "ASC" },
      take: 2,
    });
    expect(next.map((row: any) => row.id)).toEqual([3]);
  });

  it("truncates without dropping the model's indexes or validator", async () => {
    const repo = db.getRepository(Task);
    await repo.create({ title: "doomed" });
    expect(await repo.count()).toBe(1);

    await repo.truncate();

    expect(await repo.count()).toBe(0);
    // `drop()` would be the obvious way to empty a collection and the wrong
    // one: it takes the indexes and the validator with it, so the truncated
    // collection would silently stop enforcing the model.
    const indexes = await db.client.mongoListIndexes("w5_tasks");
    expect(indexes.some((index: any) => index.key?.title === 1)).toBe(true);

    const info = await db.client.mongoCommand({ listCollections: 1 });
    const entry = info.cursor.firstBatch.find(
      (each: any) => each.name === "w5_tasks",
    );
    expect(entry.options.validationLevel).toBe("moderate");
  });

  it("refuses bulkUpdate, which needs a raw SQL condition", async () => {
    const repo = db.getRepository(Task);
    const created: any = await repo.create({ title: "untouched" });

    let code = "";
    try {
      await repo.bulkUpdate([
        { where: { condition: "title = ?", params: ["untouched"] }, set: { status: "x" } },
      ]);
    } catch (error) {
      code = (error as any).code;
    }

    expect(code).toBe("MONGO_UNSUPPORTED");
    expect((await repo.findOne(created.id))?.status ?? null).toBeNull();
  });
});
