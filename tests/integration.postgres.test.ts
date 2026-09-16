import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * End-to-end coverage against a real PostgreSQL server.
 *
 * The SQL this dialect emits is unit-tested elsewhere, but a string assertion
 * can only prove we produced what we intended. Whether `$1`-style parameters
 * bind in order, whether `RETURNING *` really hands back a generated key,
 * whether `ON CONFLICT` upserts instead of duplicating — only a server can
 * settle those. That is what this file is for.
 *
 * The suite skips itself when no server is reachable, so `bun test` stays
 * green on a machine without one. Start the fleet with:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 */

const CONNECTION =
  process.env.POSTGRES_URL ||
  "postgres://stabilize:stabilize@127.0.0.1:55432/stabilize_test";

/** True when a PostgreSQL answers; decides whether the suite runs or skips. */
async function probe(): Promise<boolean> {
  const pool = new Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  } finally {
    // `end()` on a pool that never connected rejects; the probe's answer is
    // already known by then, so the teardown failure is not worth surfacing.
    await pool.end().catch(() => {});
  }
}

const available = await probe();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `[skip] No PostgreSQL at ${CONNECTION}. Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

const User = defineModel({
  tableName: "pg_users",
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
  tableName: "pg_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    // `unique` is load-bearing: the upsert below names `title` as its conflict
    // target, and PostgreSQL rejects `ON CONFLICT (title)` outright unless a
    // unique index covers it. Without the constraint `autoMigrate` creates a
    // plain column and the upsert fails with "there is no unique or exclusion
    // constraint matching the ON CONFLICT specification".
    title: { type: DataTypes.STRING, required: true, unique: true },
    body: { type: DataTypes.TEXT },
    published: { type: DataTypes.BOOLEAN },
    meta: { type: DataTypes.JSON },
    score: { type: DataTypes.DECIMAL },
    createdAt: { type: DataTypes.DATETIME },
  },
});

suite("PostgreSQL integration", () => {
  let db: any;
  let repo: any;
  let postRepo: any;

  beforeAll(async () => {
    // Start from a clean schema: a previous run's rows would collide with the
    // unique-constraint and count assertions below.
    const reset = new Pool({ connectionString: CONNECTION });
    for (const table of [
      "pg_users_history",
      "pg_posts_history",
      "pg_users",
      "pg_posts",
    ]) {
      await reset.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await reset.end();

    db = new Stabilize({ type: DBType.Postgres, connectionString: CONNECTION });
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
    expect(health.database).toBe("postgres");
  });

  it("autoMigrate is idempotent", async () => {
    // Running it a second time must not throw. `CREATE TABLE IF NOT EXISTS`
    // parses anywhere; that the server accepts it twice is the real claim.
    await db.autoMigrate([User, Post]);

    const tables = await db.client.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'pg_%'",
    );
    expect(tables.map((t: any) => t.name).sort()).toEqual([
      "pg_posts",
      "pg_users",
    ]);
  });

  it("inserts a row and returns it with a generated key", async () => {
    // `RETURNING *` is what makes this possible; without it the generated
    // `id` would have to be fetched by a second round trip, or guessed.
    const created: any = await repo.create({ name: "Ada", email: "ada@x.com" });

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
    expect(found.published).toBe(true);
    // `NUMERIC` comes back as a string from `pg` to avoid a lossy float
    // conversion, so this compares numerically rather than by type.
    expect(Number(found.score)).toBeCloseTo(12.5);
  });

  it("round-trips a JSON column as a real object", async () => {
    // `pg` parses `json`/`jsonb` back into a value on its own, and serialises
    // an object parameter on the way out. If either half were missing the
    // column would come back as a string.
    const created: any = await postRepo.create({
      title: "json",
      meta: { nested: { deep: [1, 2, 3] }, flag: false },
    });

    const found: any = await postRepo.findOne(created.id);
    expect(found.meta).toEqual({ nested: { deep: [1, 2, 3] }, flag: false });
  });

  it("counts and aggregates", async () => {
    const total = await repo.count();
    expect(total).toBeGreaterThan(0);
  });

  it("paginates with LIMIT/OFFSET", async () => {
    for (let i = 0; i < 5; i++) {
      await postRepo.create({ title: `paged-${i}`, body: "x" });
    }

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

  it("rolls back every write when the transaction throws", async () => {
    const before = await repo.count();

    // Deliberately a `try`/`catch` rather than
    // `expect(promise).rejects.toThrow("boom")`: under `bun test` the matcher
    // hangs forever when the rejection comes back through `pg`'s async
    // machinery, and the test then dies on the runner's timeout. The catch
    // below asserts exactly the same thing.
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

  it("enforces a unique constraint", async () => {
    await repo.create({ name: "unique-one", email: "dup@x.com" });

    // Same reason as the rollback test: `.rejects.toThrow()` hangs under
    // `bun test` when the failure surfaces through `pg`.
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

  it("upserts through ON CONFLICT", async () => {
    await postRepo.create({ title: "upsert-me", body: "first" });

    const result: any = await postRepo.upsert(
      { title: "upsert-me", body: "second" },
      ["title"],
    );

    expect(result).toBeDefined();

    // The conflict target must have matched and updated in place. If the
    // `ON CONFLICT` clause were wrong this is where a duplicate appears.
    const found = await postRepo.findBy({ title: "upsert-me" });
    expect(found.length).toBe(1);
    expect((found[0] as any).body).toBe("second");
  });
});
