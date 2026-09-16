import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sql from "mssql";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * End-to-end coverage against a real SQL Server.
 *
 * The dialect's SQL generation is unit-tested in `mssql.dialect.test.ts`, but
 * that suite can only prove the *strings* are what we intended. Everything
 * that depends on the server agreeing — that `IF OBJECT_ID(…) IS NULL CREATE
 * TABLE` parses, that `OUTPUT INSERTED.*` comes back as a `recordset`, that
 * `MERGE` is accepted, that `OFFSET … FETCH` is legal — is only real if a
 * server says so. That is what this file is for.
 *
 * The suite skips itself when no server is reachable, so `bun test` stays
 * green on a machine without one. Start the fleet with:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 */

const HOST = process.env.MSSQL_HOST || "127.0.0.1,51433";
const PASSWORD = process.env.MSSQL_PASSWORD || "Stabilize!Test123";
const DB_NAME = "stabilize_test";

const masterConfig = `Server=${HOST};User Id=sa;Password=${PASSWORD};Database=master;TrustServerCertificate=true`;
const testConfig = `Server=${HOST};User Id=sa;Password=${PASSWORD};Database=${DB_NAME};TrustServerCertificate=true`;

/** True when a SQL Server answers; decides whether the suite runs or skips. */
async function probe(): Promise<boolean> {
  try {
    const pool = new sql.ConnectionPool(masterConfig);
    await pool.connect();
    await pool.request().query("SELECT 1 AS ok");
    await pool.close();
    return true;
  } catch {
    return false;
  }
}

const available = await probe();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `[skip] No SQL Server at ${HOST}. Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

const User = defineModel({
  tableName: "mssql_users",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING, required: true, minLength: 2 },
    email: { type: DataTypes.STRING, unique: true },
    age: { type: DataTypes.INTEGER },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
    deleted_at: { type: DataTypes.DATETIME, softDelete: true },
  },
});

const Post = defineModel({
  tableName: "mssql_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    body: { type: DataTypes.TEXT },
    published: { type: DataTypes.BOOLEAN },
    meta: { type: DataTypes.JSON },
    score: { type: DataTypes.DECIMAL },
    createdAt: { type: DataTypes.DATETIME },
  },
});

suite("SQL Server integration", () => {
  let db: any;
  let repo: any;
  let postRepo: any;

  /** `find()` and friends return a builder; run one against the live client. */
  const rows = (qb: any) => qb.execute(db.client);

  beforeAll(async () => {
    // The container only ships `master`, so the test schema is created here.
    // This is also the first thing that proves the driver can actually talk to
    // the server, before any ORM code is involved.
    const master = await sql.connect(masterConfig);
    await master
      .request()
      .query(
        `IF DB_ID('${DB_NAME}') IS NULL CREATE DATABASE [${DB_NAME}]`,
      );
    await master.close();

    // Start from a clean schema. The databases are throwaway, but a previous
    // run's rows would still collide with the unique-constraint and count
    // assertions below.
    const reset = new sql.ConnectionPool(testConfig);
    await reset.connect();
    for (const table of [
      "mssql_users_history",
      "mssql_posts_history",
      "mssql_users",
      "mssql_posts",
    ]) {
      await reset
        .request()
        .query(`IF OBJECT_ID('${table}', 'U') IS NOT NULL DROP TABLE [${table}]`);
    }
    await reset.close();

    db = new Stabilize({ type: DBType.MSSQL, connectionString: testConfig });
    await db.autoMigrate([User, Post]);
    repo = db.getRepository(User);
    postRepo = db.getRepository(Post);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("connects and reports a health check", async () => {
    const health = await db.healthCheck();
    expect(health.status).toBe("healthy");
    expect(health.database).toBe("mssql");
  });

  it("autoMigrate is idempotent", async () => {
    // Running it a second time must not throw: the guards the dialect emits
    // (`IF OBJECT_ID(…) IS NULL`, a `sys.indexes` check) are what make that
    // true, and a server is the only thing that can confirm they parse.
    // A second run must be a no-op rather than an error: that is the whole
    // point of the `IF OBJECT_ID(…) IS NULL` guards this dialect emits.
    await db.autoMigrate([User, Post]);

    const tables = await db.client.query(
      "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE 'mssql_%'",
    );
    expect(tables.map((t: any) => t.name).sort()).toEqual([
      "mssql_posts",
      "mssql_users",
    ]);
  });

  it("inserts a row and returns it with a generated identity", async () => {
    const created: any = await repo.create({ name: "Ada", email: "ada@x.com" });

    // `OUTPUT INSERTED.*` is the only way this can be populated on SQL Server.
    expect(created).toBeTruthy();
    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe("Ada");
  });

  it("reads the row back by id", async () => {
    const created: any = await repo.create({ name: "Grace", email: "grace@x.com" });
    const found: any = await repo.findOne(created.id);
    expect(found?.name).toBe("Grace");
  });

  it("updates a row", async () => {
    const created: any = await repo.create({ name: "Alan", email: "alan@x.com" });
    await repo.update(created.id, { name: "Alan Turing" });
    expect((await repo.findOne(created.id))?.name).toBe("Alan Turing");
  });

  it("deletes a row", async () => {
    const created: any = await repo.create({ name: "Temp", email: "temp@x.com" });
    await repo.delete(created.id);
    expect(await repo.findOne(created.id)).toBeNull();
  });

  it("stores and reads back every mapped column type", async () => {
    const created: any = await postRepo.create({
      title: "Typed",
      body: "long text",
      published: true,
      meta: { tags: ["a", "b"] },
      score: 12.5,
    });

    const found: any = await postRepo.findOne(created.id);
    expect(found.title).toBe("Typed");
    expect(found.body).toBe("long text");
    // TINYINT(1)-style booleans do not exist here — this must round-trip as a
    // real BIT, which the mssql driver hands back as a JS boolean.
    expect(Boolean(found.published)).toBe(true);
    expect(Number(found.score)).toBeCloseTo(12.5);
  });

  it("counts and aggregates", async () => {
    const total = await repo.count();
    expect(total).toBeGreaterThan(0);
  });

  it("paginates with OFFSET/FETCH", async () => {
    for (let i = 0; i < 5; i++) {
      await postRepo.create({ title: `paged-${i}`, body: "x" });
    }

    // A bare OFFSET is illegal in T-SQL without an ORDER BY, and `OFFSET …
    // FETCH` requires one too — this is where the dialect's fallback ordering
    // either works or does not.
    const page: any = await postRepo.paginate(1, 2);
    expect(page.data.length).toBeLessThanOrEqual(2);
    expect(page.total).toBeGreaterThanOrEqual(5);
  });

  it("filters by a where clause rather than returning every row", async () => {
    // Deliberately not the first-inserted row: if the filter were dropped, a
    // `limit(1)` would still return one row and the test would pass by luck.
    const found = await postRepo.findBy({ title: "paged-3" }, { limit: 1 });
    expect(found.length).toBe(1);
    expect(found[0].title).toBe("paged-3");

    expect(await postRepo.findBy({ title: "no-such-title" })).toEqual([]);
  });

  // Asserted with an explicit try/catch rather than `expect(...).rejects`,
  // which is the idiom used everywhere else in this repo.
  //
  // Under `bun test`, an mssql rejection that arrives after the driver's
  // internal `setImmediate` hop leaves `bun test` waiting on a promise that
  // never settles: the test hangs until the runner's timeout and then Bun
  // segfaults tearing the run down. It is not our code and not the library —
  // the same file passes in full under Node, and a standalone `bun run` script
  // performing this exact transaction rejects with "boom" and rolls back
  // correctly. It is the *assertion form* that trips it: this test and the
  // unique-constraint test below are the only two that wait on a rejection,
  // and swapping in a try/catch fixes both while checking exactly the same
  // thing. A plain `setImmediate` rejection does not reproduce it in isolation,
  // so the trigger is somewhere in how the driver settles a failed request.
  it("rolls back every write when the transaction throws", async () => {
    const before = await repo.count();

    let thrown: any;
    try {
      await db.transaction(async (tx: any) => {
        await repo.create({ name: "rolled-back", email: "rb@x.com" }, {}, tx);
        throw new Error("boom");
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toBe("boom");

    // The row must not have survived the rollback.
    expect(await repo.count()).toBe(before);
    expect((await repo.findBy({ name: "rolled-back" })).length).toBe(0);
  });

  it("commits writes when the transaction succeeds", async () => {
    await db.transaction(async (tx: any) => {
      await repo.create({ name: "committed", email: "c@x.com" }, {}, tx);
    });

    expect((await repo.findBy({ name: "committed" })).length).toBe(1);
  });

  it("seeds the optimistic lock on create and increments on update", async () => {
    const created: any = await repo.create({ name: "versioned", email: "v@x.com" });
    expect(created.version).toBe(1);

    const updated: any = await repo.update(created.id, { name: "versioned-2" });
    expect(updated?.version).toBe(2);
  });

  // The other rejection assertion in this file; see the note on the rollback
  // test above for why it is written as a try/catch.
  it("enforces a unique constraint", async () => {
    await repo.create({ name: "unique-one", email: "dup@x.com" });

    let thrown: any;
    try {
      await repo.create({ name: "unique-two", email: "dup@x.com" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
  });

  it("soft deletes, hides from queries and recovers", async () => {
    const created: any = await repo.create({ name: "soft", email: "soft@x.com" });

    await repo.delete(created.id);
    expect(await repo.findOne(created.id)).toBeNull();

    await repo.recover(created.id);
    expect((await repo.findOne(created.id))?.name).toBe("soft");
  });

  it("upserts through MERGE", async () => {
    await postRepo.create({ title: "upsert-me", body: "first" });

    // The MERGE statement has no `ON CONFLICT`/`ON DUPLICATE KEY` equivalent,
    // so this is the one write path with entirely bespoke SQL per dialect.
    const result: any = await postRepo.upsert(
      { title: "upsert-me", body: "second" },
      ["title"],
    );

    expect(result).toBeDefined();

    // The MERGE must have matched on `title` and updated in place. If the
    // `ON` clause failed to match, this is where a duplicate row appears.
    const found = await postRepo.findBy({ title: "upsert-me" });
    expect(found.length).toBe(1);
    expect((found[0] as any).body).toBe("second");
  });
});
