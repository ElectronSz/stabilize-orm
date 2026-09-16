import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { QueryBuilder } from "../query-builder";
import { Repository } from "../repository";
import { defineModel } from "../model";
import { DataTypes, DBType, StabilizeError } from "../types";
import type { Predicate, MongoStep } from "../index";

/**
 * Escape hatches on MongoDB: the clauses that have no equivalent, and the error
 * a caller gets for reaching for one.
 *
 * `tests/mongo.dialect.test.ts` already proves `buildMongoSpec` throws when it
 * is *handed* a blocker. What that cannot prove is the thing this file exists
 * for: that the builder actually wires the blockers it records into
 * `buildMongoSpec`, and that `execute()` actually reaches `buildMongoSpec`. A
 * method that records a blocker nothing consults is worse than one that does not
 * — a `join()` that is silently dropped returns the wrong rows with no error at
 * all, and a caller has no way to notice.
 *
 * So the assertions run over the real API twice: once against `buildMongo()`
 * with no server (which isolates the builder → spec wiring), and once against
 * `execute(client)` (which adds the execute → builder wiring). The first half
 * runs everywhere; the second skips itself when the replica set is not up.
 *
 * The two names this backend adds to the published entry point are pinned here
 * too, for want of a file that owns the public surface.
 *
 * Start the fleet with:
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

/** Collections this file owns. The shared counters collection is not one. */
const COLLECTIONS = ["b9_docs", "b9_posts"];

const B9Doc = defineModel({
  tableName: "b9_docs",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
  },
});

const B9Post = defineModel({
  tableName: "b9_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    docId: { type: DataTypes.INTEGER, name: "doc_id" },
  },
});

/**
 * Every method that records a blocker, with a call that exercises it.
 *
 * Exhaustive rather than illustrative: the failure this guards against is a
 * *single* method whose blocker never reaches the spec, and a table that named
 * only the interesting ones would not catch it.
 */
const BLOCKING: {
  method: string;
  detail?: string;
  call: (q: QueryBuilder<any>) => QueryBuilder<any>;
}[] = [
  {
    method: "selectRaw",
    detail: "UPPER(title) AS shout",
    call: (q) => q.selectRaw("UPPER(title) AS shout"),
  },
  { method: "distinct", call: (q) => q.distinct() },
  {
    method: "where",
    detail: "title = 'a'",
    call: (q) => q.where("title = 'a'"),
  },
  {
    method: "orWhere",
    detail: "title = 'b'",
    call: (q) => q.orWhere("title = 'b'"),
  },
  {
    method: "whereNot",
    detail: "title = 'c'",
    call: (q) => q.whereNot("title = 'c'"),
  },
  {
    method: "whereExists",
    detail: "SELECT 1",
    call: (q) => q.whereExists("SELECT 1"),
  },
  {
    method: "whereNotExists",
    detail: "SELECT 1",
    call: (q) => q.whereNotExists("SELECT 1"),
  },
  {
    method: "whereRaw",
    detail: "LOWER(title) = 'a'",
    call: (q) => q.whereRaw("LOWER(title) = 'a'"),
  },
  {
    method: "whereRef",
    detail: "b9_docs.title = b9_posts.title",
    call: (q) => q.whereRef("b9_docs.title", "=", "b9_posts.title"),
  },
  {
    method: "join",
    detail: "LEFT JOIN b9_posts ON b9_posts.doc_id = b9_docs.id",
    call: (q) => q.join("b9_posts", "b9_posts.doc_id = b9_docs.id"),
  },
  {
    method: "innerJoin",
    detail: "INNER JOIN b9_posts ON b9_posts.doc_id = b9_docs.id",
    call: (q) => q.innerJoin("b9_posts", "b9_posts.doc_id = b9_docs.id"),
  },
  {
    method: "leftJoin",
    detail: "LEFT JOIN b9_posts ON b9_posts.doc_id = b9_docs.id",
    call: (q) => q.leftJoin("b9_posts", "b9_posts.doc_id = b9_docs.id"),
  },
  {
    method: "rightJoin",
    detail: "RIGHT JOIN b9_posts ON b9_posts.doc_id = b9_docs.id",
    call: (q) => q.rightJoin("b9_posts", "b9_posts.doc_id = b9_docs.id"),
  },
  {
    method: "fullJoin",
    detail: "FULL JOIN b9_posts ON b9_posts.doc_id = b9_docs.id",
    call: (q) => q.fullJoin("b9_posts", "b9_posts.doc_id = b9_docs.id"),
  },
  {
    method: "crossJoin",
    detail: "b9_posts",
    call: (q) => q.crossJoin("b9_posts"),
  },
  {
    method: "orderByRaw",
    detail: "LENGTH(title)",
    call: (q) => q.orderByRaw("LENGTH(title)"),
  },
  {
    method: "groupByRaw",
    detail: "LOWER(title)",
    call: (q) => q.groupByRaw("LOWER(title)"),
  },
  {
    method: "having",
    detail: "COUNT(*) > 1",
    call: (q) => q.having("COUNT(*) > 1"),
  },
  { method: "union", call: (q) => q.union(new QueryBuilder("b9_posts")) },
  { method: "unionAll", call: (q) => q.unionAll(new QueryBuilder("b9_posts")) },
  { method: "with", call: (q) => q.with("c", new QueryBuilder("b9_posts")) },
  {
    method: "withRecursive",
    call: (q) => q.withRecursive("c", new QueryBuilder("b9_posts")),
  },
];

/**
 * Clauses that *are* translatable.
 *
 * The other half of the rule: a blocker table that reported too much would make
 * MongoDB unusable in a way no thrown-error test would notice, because every
 * one of those tests passes when everything throws.
 */
const ALLOWED: {
  name: string;
  call: (q: QueryBuilder<any>) => QueryBuilder<any>;
}[] = [
  { name: "whereEq", call: (q) => q.whereEq("title", "a") },
  { name: "whereNotEq", call: (q) => q.whereNotEq("title", "a") },
  { name: "whereCompare", call: (q) => q.whereCompare("id", "<", 3) },
  { name: "orWhereEq", call: (q) => q.orWhereEq("title", "a") },
  { name: "orWhereCompare", call: (q) => q.orWhereCompare("id", ">", 1) },
  { name: "orWhereNull", call: (q) => q.orWhereNull("title") },
  { name: "orWhereNotNull", call: (q) => q.orWhereNotNull("title") },
  { name: "orWhereIn", call: (q) => q.orWhereIn("title", ["a", "b"]) },
  { name: "whereIn", call: (q) => q.whereIn("title", ["a", "b"]) },
  { name: "whereNotIn", call: (q) => q.whereNotIn("title", ["a"]) },
  { name: "whereNull", call: (q) => q.whereNull("title") },
  { name: "whereNotNull", call: (q) => q.whereNotNull("title") },
  { name: "whereBetween", call: (q) => q.whereBetween("id", 1, 2) },
  { name: "whereNotBetween", call: (q) => q.whereNotBetween("id", 1, 2) },
  { name: "whereLike", call: (q) => q.whereLike("title", "a%") },
  { name: "whereILike", call: (q) => q.whereILike("title", "a%") },
  { name: "orderBy", call: (q) => q.orderBy("title", "DESC") },
  { name: "groupBy", call: (q) => q.groupBy("title") },
  { name: "limit", call: (q) => q.limit(5) },
  { name: "offset", call: (q) => q.offset(5) },
  { name: "paginate", call: (q) => q.paginate(2, 10) },
  { name: "take", call: (q) => q.take(1) },
  { name: "skip", call: (q) => q.skip(1) },
  { name: "first", call: (q) => q.first() },
  { name: "select", call: (q) => q.select("id", "title") },
  { name: "as", call: (q) => q.as("d").select("d.id", "d.title") },
  { name: "withRelations", call: (q) => q.withRelations("posts") },
  { name: "count", call: (q) => q.count("id", "n") },
  { name: "sum", call: (q) => q.sum("id", "n") },
  { name: "avg", call: (q) => q.avg("id", "n") },
  { name: "min", call: (q) => q.min("id", "n") },
  { name: "max", call: (q) => q.max("id", "n") },
  // Row locking is the documented no-op: Mongo has no row lock to map it
  // onto, and the SQL Server path already treats it the same way.
  { name: "lock", call: (q) => q.lock("FOR UPDATE") },
  { name: "forUpdate", call: (q) => q.forUpdate() },
  { name: "forShare", call: (q) => q.forShare() },
];

/** Runs `call` and returns whatever it threw, or null. */
function caught(fn: () => unknown): StabilizeError | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error as StabilizeError;
  }
}

// ─── PUBLIC SURFACE ───────────────────────────────────────────────────

describe("mongo public surface", () => {
  it("re-exports the predicate and the migration step", () => {
    // Both are types, so there is nothing here for the runner to assert: the
    // check is that the two imports above resolve at all. `tests/` sits outside
    // the repo's tsconfig, so `bun tsc --noEmit` never sees them; the gate that
    // does is `bun run build`, which must emit both names into
    // `dist/index.d.ts`. The lines below only pin their shapes.
    const predicate: Predicate = { op: "cmp", column: "title", value: "first" };
    const step: MongoStep = { kind: "dropCollection", collection: "b9_docs" };

    expect(predicate.op).toBe("cmp");
    expect(step.kind).toBe("dropCollection");
  });
});

// ─── BUILDER → SPEC WIRING (no server) ────────────────────────────────

describe("mongo blockers: the builder wires what it records", () => {
  for (const { method, detail, call } of BLOCKING) {
    it(`refuses ${method}() in buildMongo()`, () => {
      const error = caught(() =>
        call(new QueryBuilder("b9_docs")).buildMongo(),
      );

      expect(error).toBeInstanceOf(StabilizeError);
      expect(error!.code).toBe("MONGO_UNSUPPORTED");
      // The method is named, not just "something".
      expect(error!.message).toContain(method);
      if (detail !== undefined) {
        // And the offending fragment is quoted back, so the caller can find it.
        expect(error!.message).toContain(`${method}: ${detail}`);
      }
      // The message has to say what to reach for instead, or a caller's only
      // option is to guess.
      expect(error!.message).toContain("withRelations()");
    });
  }

  it("names every blocked clause at once, not only the first", () => {
    const error = caught(() =>
      new QueryBuilder("b9_docs")
        .innerJoin("b9_posts", "b9_posts.doc_id = b9_docs.id")
        .whereRaw("LOWER(title) = 'a'")
        .orderByRaw("LENGTH(title)")
        .buildMongo(),
    );

    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    for (const method of ["innerJoin", "whereRaw", "orderByRaw"]) {
      expect(error!.message).toContain(method);
    }
    expect(error!.message).toContain("have no MongoDB equivalent");
  });

  it("keeps rendering the SQL it always did", () => {
    // Blockers are recorded *alongside* the SQL arrays, not instead of them, so
    // the four working backends keep emitting byte-identical statements.
    const qb = new QueryBuilder("b9_docs").innerJoin(
      "b9_posts",
      "b9_posts.doc_id = b9_docs.id",
    );
    const { query, params } = qb.build(DBType.Postgres);

    expect(query).toContain(
      "INNER JOIN b9_posts ON b9_posts.doc_id = b9_docs.id",
    );
    expect(params).toEqual([]);
    // …and the same builder still refuses to be one.
    expect(caught(() => qb.buildMongo())!.code).toBe("MONGO_UNSUPPORTED");
  });

  it("reports a projection that cannot be built rather than widening to *", () => {
    // `select()` has no blocker of its own — the expression is only unbuildable
    // once someone asks what it projects, which is what `buildMongo` checks.
    const error = caught(() =>
      new QueryBuilder("b9_docs").select("UPPER(title)").buildMongo(),
    );

    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    expect(error!.message).toContain("select");
    expect(error!.message).toContain("UPPER(title)");
  });

  it("accepts every clause that does translate", () => {
    for (const { name, call } of ALLOWED) {
      const error = caught(() =>
        call(new QueryBuilder("b9_docs")).buildMongo(),
      );
      expect(
        error,
        `${name}() should not be reported as unsupported`,
      ).toBeNull();
    }
  });

  it("carries blockers into a clone, without leaking them back", () => {
    // `countExec` and `existsExec` both clone before they build, so a blocker
    // that did not survive the clone would be dropped on those two paths only.
    const original = new QueryBuilder("b9_docs");
    const clone = original
      .clone()
      .innerJoin("b9_posts", "b9_posts.doc_id = b9_docs.id");

    expect(caught(() => clone.buildMongo())!.code).toBe("MONGO_UNSUPPORTED");
    expect(caught(() => original.buildMongo())).toBeNull();
  });

  it("turns a translatable query into the spec it should be", () => {
    // The control for every assertion above: this builder is capable of
    // producing a spec, so their failures are about the blockers.
    const spec = new QueryBuilder("b9_docs")
      .whereEq("title", "first")
      .orderBy("id", "DESC")
      .limit(2)
      .offset(3)
      .buildMongo();

    expect(spec.filter).toEqual({ title: "first" });
    expect(spec.sort).toEqual({ _id: -1 });
    expect(spec.limit).toBe(2);
    expect(spec.skip).toBe(3);
  });
});

// ─── EXECUTE → BUILDER → SPEC WIRING (needs a server) ─────────────────

suite("mongo blockers: execute() consults them", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    // Two rows in each, so a *silenced* join would visibly return more (or
    // fewer) rows than the caller asked for rather than failing loudly.
    await db.client.mongoInsertMany("b9_docs", [
      { _id: 1, title: "first" },
      { _id: 2, title: "second" },
    ]);
    await db.client.mongoInsertMany("b9_posts", [
      { _id: 10, title: "p1", doc_id: 1 },
      { _id: 11, title: "p2", doc_id: 1 },
      { _id: 12, title: "p3", doc_id: 2 },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    await db.close();
  });

  it("reads plainly when nothing is blocked", async () => {
    // The control. Without this, every assertion below would also pass against
    // an `execute()` that threw unconditionally.
    const docs = await db
      .getRepository(B9Doc)
      .find()
      .orderBy("id", "ASC")
      .execute(db.client);

    expect(docs.map((d: any) => d.title)).toEqual(["first", "second"]);
  });

  it("calls buildMongo() on the way through execute()", async () => {
    // Read as a wiring assertion rather than a behaviour one. The table below
    // proves each blocker is *recorded* and that `buildMongo()` raises it; this
    // proves `execute()` goes through `buildMongo()` at all, which is the edge
    // that a builder recording blockers no one consults would break.
    const qb = new QueryBuilder("b9_docs");
    const real = qb.buildMongo.bind(qb);
    let calls = 0;
    qb.buildMongo = () => {
      calls += 1;
      return real();
    };

    const docs = await qb.whereEq("title", "first").execute(db.client);

    expect(calls).toBe(1);
    expect(docs).toHaveLength(1);
  });

  it("throws for a projection only `buildMongo()` can judge", async () => {
    // `select()` records nothing when it is called — an expression is only
    // unbuildable once someone asks what it projects. So this case fails if
    // `execute()` skips `buildMongo()` in a way the table above would not: it
    // pins the execute → build edge itself, not just the blocker wiring.
    const error = await (async () => {
      try {
        await db
          .getRepository(B9Doc)
          .find()
          .select("UPPER(title)")
          .execute(db.client);
        return null;
      } catch (thrown) {
        return thrown as StabilizeError;
      }
    })();

    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    expect(error!.message).toContain("UPPER(title)");
  });

  for (const { method, call } of BLOCKING) {
    it(`throws MONGO_UNSUPPORTED out of execute() for ${method}()`, async () => {
      const repo = db.getRepository(B9Doc);
      const error = await (async () => {
        try {
          await call(repo.find()).execute(db.client);
          return null;
        } catch (thrown) {
          return thrown as StabilizeError;
        }
      })();

      expect(
        error,
        `${method}() did not throw — a silenced clause returns the wrong rows`,
      ).not.toBeNull();
      expect(error).toBeInstanceOf(StabilizeError);
      expect(error!.code).toBe("MONGO_UNSUPPORTED");
      expect(error!.message).toContain(method);
    });
  }

  it("throws out of countExec() and existsExec(), which build a clone", async () => {
    const join = (q: QueryBuilder<any>) =>
      q.innerJoin("b9_posts", "b9_posts.doc_id = b9_docs.id");

    const countError = await (async () => {
      try {
        await join(new QueryBuilder("b9_docs")).countExec(db.client);
        return null;
      } catch (thrown) {
        return thrown as StabilizeError;
      }
    })();
    expect(countError!.code).toBe("MONGO_UNSUPPORTED");
    expect(countError!.message).toContain("innerJoin");

    const existsError = await (async () => {
      try {
        await join(new QueryBuilder("b9_docs")).existsExec(db.client);
        return null;
      } catch (thrown) {
        return thrown as StabilizeError;
      }
    })();
    expect(existsError!.code).toBe("MONGO_UNSUPPORTED");
    expect(existsError!.message).toContain("innerJoin");
  });

  it("still throws when an aggregate and a blocker are combined", async () => {
    // `count()` replaces the projection, and `executeMongo` then takes a
    // different branch entirely — it sends a pipeline rather than a find. The
    // blocker has to be consulted before either branch is chosen.
    const error = await (async () => {
      try {
        await db
          .getRepository(B9Doc)
          .find()
          .count("id", "n")
          .innerJoin("b9_posts", "b9_posts.doc_id = b9_docs.id")
          .execute(db.client);
        return null;
      } catch (thrown) {
        return thrown as StabilizeError;
      }
    })();

    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    expect(error!.message).toContain("innerJoin");
  });

  it("still throws when relations were requested too", async () => {
    // `withRelations()` is the documented replacement for a join, but it must
    // not be read as *permission*: a query that asked for both is still one the
    // server cannot answer as written.
    const error = await (async () => {
      try {
        await db
          .getRepository(B9Doc)
          .find()
          .withRelations("posts")
          .innerJoin("b9_posts", "b9_posts.doc_id = b9_docs.id")
          .execute(db.client);
        return null;
      } catch (thrown) {
        return thrown as StabilizeError;
      }
    })();

    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    expect(error!.message).toContain("innerJoin");
  });

  it("treats lock()/forUpdate() as a no-op rather than a blocker", async () => {
    const docs = await db
      .getRepository(B9Doc)
      .find()
      .forUpdate()
      .orderBy("id", "ASC")
      .execute(db.client);

    expect(docs).toHaveLength(2);
  });

  it("accepts lockForUpdate() and returns the row unprotected", async () => {
    // The repository's own spelling of the same no-op. It reads as a lock and
    // takes none, which is the reason it is documented rather than thrown:
    // refusing would break a read that has a correct answer.
    const repo = db.getRepository(B9Doc);
    const doc = await repo.lockForUpdate(1);

    expect(doc?.title).toBe("first");
  });

  it("warns that lockForUpdate() takes no lock, rather than doing it silently", async () => {
    // The read above is correct either way, which is exactly the hazard: a
    // caller who asked for a lock by name gets a result indistinguishable from
    // one that was locked, does read-modify-write on the strength of it, and
    // loses the update against a concurrent writer with nothing to notice.
    // Throwing would refuse a query that has a good answer, so the diagnostic
    // is the whole remedy — and a diagnostic nothing asserts is a diagnostic
    // that can be deleted by accident.
    const warnings: string[] = [];
    const stubLogger = {
      logError: () => {},
      logInfo: () => {},
      logWarn: (message: string) => warnings.push(message),
      logDebug: () => {},
    } as any;
    const repo = new Repository(
      db.client,
      B9Doc as any,
      { enabled: false, ttl: 60 },
      stubLogger,
    );

    const doc = await repo.lockForUpdate(1);

    expect(doc?.title).toBe("first");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("lockForUpdate");
    expect(warnings[0]).toContain("b9_docs");
    expect(warnings[0]).toContain("no lock on MongoDB");
  });

  it("answers count() and exists() without SQL", async () => {
    const repo = db.getRepository(B9Doc);
    expect(await repo.count({})).toBe(2);
    expect(await repo.count({ title: "first" })).toBe(1);
    expect(await repo.exists({ title: "first" })).toBe(true);
    expect(await repo.exists({ title: "nope" })).toBe(false);
  });

  // ─── raw SQL escape hatches ────────────────────────────────────────

  it("refuses rawQuery() on the repository with MONGO_UNSUPPORTED", async () => {
    const error = await (async () => {
      try {
        await db.getRepository(B9Doc).rawQuery("SELECT * FROM b9_docs");
        return null;
      } catch (thrown) {
        return thrown as StabilizeError;
      }
    })();

    expect(error).toBeInstanceOf(StabilizeError);
    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    // The message has to point somewhere, or "no" is all the caller learns.
    expect(error!.message).toMatch(/structured methods|repository API/);
  });

  it("refuses rawQuery()/rawExec() on the Stabilize instance", async () => {
    for (const attempt of [
      () => db.rawQuery("SELECT * FROM b9_docs"),
      () => db.rawExec("DELETE FROM b9_docs"),
    ]) {
      const error = await (async () => {
        try {
          await attempt();
          return null;
        } catch (thrown) {
          return thrown as StabilizeError;
        }
      })();

      expect(error).toBeInstanceOf(StabilizeError);
      expect(error!.code).toBe("MONGO_UNSUPPORTED");
      expect(error!.message).not.toBe("");
    }
  });

  it("tells the caller to use updateBy() for a raw WHERE", async () => {
    // The one place the message names the exact replacement, because there is
    // exactly one.
    const error = await (async () => {
      try {
        await db
          .getRepository(B9Doc)
          .bulkUpdate([
            {
              where: { condition: "title = ?", params: ["first"] },
              set: { title: "x" },
            },
          ]);
        return null;
      } catch (thrown) {
        return thrown as StabilizeError;
      }
    })();

    expect(error).toBeInstanceOf(StabilizeError);
    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    expect(error!.message).toContain("updateBy()");
  });
});
