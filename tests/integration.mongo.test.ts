import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";
import { MONGO_COUNTERS_COLLECTION } from "../mongo-repository";

/**
 * End-to-end coverage for the MongoDB backend, against a real server.
 *
 * The suite skips itself when the replica set is not running, so `bun test`
 * stays green on a machine without the fleet:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 *
 * Two properties of the probe are deliberate. The driver import is *inside* the
 * `try`, because `mongodb` is an optional dependency and a top-level import
 * would break `bun test` for anyone who has not installed it. And the probe
 * asks `hello` for `setName` rather than pinging: a standalone answers every
 * read and then fails every write, because the ORM wraps each one in a
 * transaction — so a ping would call a server "available" that cannot store
 * anything.
 */

const REPLICA_SET_URL =
  process.env.MONGO_URL ||
  "mongodb://127.0.0.1:57017/stabilize_test?directConnection=true&replicaSet=rs0";

/** The driver import must stay inside the try. See the note above. */
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

/**
 * A model whose key is generated, so the counter is what produces the id.
 *
 * `fullName` is renamed to prove the column mapping holds on the way in and on
 * the way out, which is the part a document store makes easy to get subtly
 * wrong.
 */
const Widget = defineModel({
  tableName: "m3_widgets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING, required: true },
    fullName: { type: DataTypes.STRING, name: "full_name" },
    active: { type: DataTypes.BOOLEAN },
  },
});

/** A model with a caller-supplied string key, so nothing is allocated. */
const Coupon = defineModel({
  tableName: "m3_coupons",
  columns: {
    id: { type: DataTypes.STRING, required: true },
    label: { type: DataTypes.STRING },
  },
});

const COLLECTIONS = [
  "m3_widgets",
  "m3_coupons",
  MONGO_COUNTERS_COLLECTION,
];

suite("MongoDB integration", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    // Dropped rather than assumed absent: the counters collection is what makes
    // `id === 1` a meaningful assertion, and a leftover counter from an earlier
    // run would hand out a higher id and turn this into a false failure.
    for (const name of COLLECTIONS) {
      await db.client.mongoDeleteMany(name, {});
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of COLLECTIONS) {
      await db.client.mongoDeleteMany(name, {}).catch(() => {});
    }
    await db.close();
  });

  it("is serving transactions, which every write depends on", async () => {
    const hello = await db.client.mongoCommand({ hello: 1 });
    expect(hello.setName).toBe("rs0");
  });

  // ─── the counter ───────────────────────────────────────────────────

  it("generates id 1 for the first document in a fresh collection", async () => {
    const created: any = await db
      .getRepository(Widget)
      .create({ name: "first", fullName: "First Widget" });

    expect(created.id).toBe(1);
    expect(Number.isInteger(created.id)).toBe(true);
    expect(created.full_name).toBe("First Widget");
  });

  it("stores the generated id as _id", async () => {
    const raw = await db.client.mongoFindOne("m3_widgets", {
      _id: 1,
    });
    expect(raw).not.toBeNull();
    expect(raw.name).toBe("first");
    // The id is the storage key, not a field beside it.
    expect(raw.id).toBeUndefined();
  });

  it("reads the row back by id", async () => {
    const found: any = await db.getRepository(Widget).findOne(1);
    expect(found).not.toBeNull();
    expect(found.id).toBe(1);
    expect(found.name).toBe("first");
  });

  it("keeps counting up from the counter document", async () => {
    const repo = db.getRepository(Widget);
    const second: any = await repo.create({ name: "second" });
    const third: any = await repo.create({ name: "third" });
    expect(second.id).toBe(2);
    expect(third.id).toBe(3);

    const counter = await db.client.mongoFindOne(MONGO_COUNTERS_COLLECTION, {
      _id: "m3_widgets",
    });
    expect(counter.seq).toBe(3);
  });

  it("allocates a contiguous block for one bulkCreate", async () => {
    await db.client.mongoDeleteMany("m3_bulk", {});
    const Bulk = defineModel({
      tableName: "m3_bulk",
      columns: {
        id: { type: DataTypes.INTEGER, required: true },
        name: { type: DataTypes.STRING },
      },
    });
    const repo = db.getRepository(Bulk);

    const created: any[] = await repo.bulkCreate(
      Array.from({ length: 20 }, (_, i) => ({ name: `row-${i}` })),
    );

    // Contiguous and in input order. The SQL path has to work out which keys a
    // multi-row INSERT produced; here one `$inc` reserved the whole block.
    expect(created.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );

    const counter = await db.client.mongoFindOne(MONGO_COUNTERS_COLLECTION, {
      _id: "m3_bulk",
    });
    expect(counter.seq).toBe(20);
    await db.client.mongoDeleteMany("m3_bulk", {});
    await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
      _id: "m3_bulk",
    });
  });

  it("advances the counter past a caller-supplied id", async () => {
    const repo = db.getRepository(Widget);
    const explicit: any = await repo.create({ id: 500, name: "explicit" });
    expect(explicit.id).toBe(500);

    // Without the `$max` bump this would be handed 4 and collide with a
    // document that already exists.
    const next: any = await repo.create({ name: "after-explicit" });
    expect(next.id).toBe(501);
  });

  it("honours a caller-supplied key without touching the counter", async () => {
    const repo = db.getRepository(Coupon);
    const created: any = await repo.create({ id: "SAVE10", label: "Ten off" });
    expect(created.id).toBe("SAVE10");
    expect((await repo.findOne("SAVE10")).label).toBe("Ten off");

    const counter = await db.client.mongoFindOne(MONGO_COUNTERS_COLLECTION, {
      _id: "m3_coupons",
    });
    expect(counter).toBeNull();
  });

  it("surfaces a write failure with its own error code", async () => {
    // Every write goes through a transaction, and the transaction used to
    // rewrite whatever came back out of it as TX_ERROR. So a payload that
    // failed validation was reported as a transaction problem, with a message
    // about replica sets — the wrong code to branch on and the wrong thing to
    // go and look at. The four SQL backends all let the original through.
    let code = "";
    let message = "";
    try {
      await db.getRepository(Widget).create({});
    } catch (error) {
      code = (error as any).code;
      message = (error as Error).message;
    }

    expect(code).toBe("VALIDATION_ERROR");
    expect(message).toContain("name");
    expect(message).not.toContain("replica set");
  });

  // ─── the read path ─────────────────────────────────────────────────

  it("counts and reports existence through the query builder", async () => {
    const repo = db.getRepository(Widget);
    expect(await repo.count()).toBe(5);
    expect(await repo.exists({ name: "first" })).toBe(true);
    expect(await repo.exists({ name: "nobody" })).toBe(false);
  });

  it("filters, sorts and limits", async () => {
    const repo = db.getRepository(Widget);
    const rows: any[] = await repo.find().whereEq("name", "second").execute(db.client);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(2);

    const ordered: any[] = await repo.find().orderBy("id", "DESC").limit(2).execute(db.client);
    expect(ordered.map((row) => row.id)).toEqual([501, 500]);
  });

  it("projects only the columns asked for", async () => {
    const repo = db.getRepository(Widget);
    const rows: any[] = await repo
      .find()
      .select("name")
      .whereEq("id", 1)
      .execute(db.client);
    expect(rows[0].name).toBe("first");
    // The id is always projected: a row with no key is not addressable.
    expect(rows[0].id).toBe(1);
    expect(rows[0].full_name).toBeUndefined();
  });

  it("reads a null-valued column as absent rather than as a stored null", async () => {
    const repo = db.getRepository(Widget);
    const created: any = await repo.create({ name: "no-full-name" });
    const raw = await db.client.mongoFindOne("m3_widgets", {
      _id: created.id,
    });
    // Omitted, not `full_name: null` — an explicit null would collide in a
    // sparse unique index, which is what the schema relies on.
    expect("full_name" in raw).toBe(false);
    expect(created.full_name ?? null).toBeNull();
  });

  it("keeps booleans as booleans", async () => {
    const repo = db.getRepository(Widget);
    const created: any = await repo.create({ name: "flagged", active: true });
    const raw = await db.client.mongoFindOne("m3_widgets", {
      _id: created.id,
    });
    // The SQL path coerces a boolean to 1/0, which on Mongo would fail a
    // `{bsonType: "bool"}` validator and make `whereEq("active", true)` match
    // nothing.
    expect(raw.active).toBe(true);
  });

  it("applies the beforeCreate hook before the document is built", async () => {
    const Slugged = defineModel({
      tableName: "m3_slugged",
      columns: {
        id: { type: DataTypes.INTEGER, required: true },
        title: { type: DataTypes.STRING, required: true },
        slug: { type: DataTypes.STRING },
      },
      hooks: {
        beforeCreate: (entity: any) => {
          entity.slug = String(entity.title).toLowerCase().replace(/\s+/g, "-");
        },
      },
    });
    const created: any = await db
      .getRepository(Slugged)
      .create({ title: "Hello World" });
    expect(created.slug).toBe("hello-world");
    expect((await db.getRepository(Slugged).findOne(created.id)).slug).toBe(
      "hello-world",
    );

    await db.client.mongoDeleteMany("m3_slugged", {});
    await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
      _id: "m3_slugged",
    });
  });

  it("visits every row exactly once when paging an unordered query", async () => {
    // `eachBatch` walks the result set with `skip`/`limit` in a loop and sets
    // no sort, which is safe on SQLite only because a rowid scan is stable.
    // Mongo's `skip` over an unordered query has no such guarantee: the server
    // is free to hand back a different order per call, so the second page can
    // repeat rows from the first and drop others entirely — with no error, and
    // a callback that has already been applied to whatever it was given.
    //
    // The fix is the implicit `{_id: 1}` sort the builder adds whenever a skip
    // is set, which makes the order total and therefore the paging exact. That
    // the sort is emitted is pinned without a server in
    // `mongo.dialect.test.ts`; what this case adds is that the loop built on it
    // terminates and stops at the short page.
    const Paged = defineModel({
      tableName: "m3_paged",
      columns: {
        id: { type: DataTypes.INTEGER, required: true },
        name: { type: DataTypes.STRING },
      },
    });
    await db.client.mongoDeleteMany("m3_paged", {});
    await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
      _id: "m3_paged",
    });

    const repo = db.getRepository(Paged);
    await repo.bulkCreate(
      Array.from({ length: 250 }, (_, i) => ({ name: `row-${i}` })),
    );

    const seen: number[] = [];
    let batches = 0;
    await repo.eachBatch(
      repo.find(),
      (batch: any[]) => {
        batches++;
        for (const row of batch) seen.push(row.id);
      },
      100,
    );

    // 250 rows at 100 per page: 100, 100, 50 — the short final page is what
    // stops the loop, so a page that came back full forever would hang here.
    expect(batches).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(250);

    await db.client.mongoDeleteMany("m3_paged", {});
    await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
      _id: "m3_paged",
    });
  });
});
