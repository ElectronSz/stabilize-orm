import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * End-to-end coverage against a real MySQL 8 server.
 *
 * The SQL this dialect emits is unit-tested elsewhere, but a string assertion
 * can only prove we produced what we intended. Whether `?` parameters bind in
 * order, whether `LAST_INSERT_ID()` really hands back a generated key, whether
 * `ON DUPLICATE KEY UPDATE` upserts instead of duplicating — only a server can
 * settle those. That is what this file is for.
 *
 * MySQL is also the dialect where identifiers have to be backticked rather
 * than double-quoted, and where a `DATETIME` column refuses the ISO-8601 form
 * the other three take. Those are properties of the DDL builder and the
 * parameter binding rather than of a query, so the schema below is created by
 * `autoMigrate` itself — nothing is created by hand, and a regression in the
 * generated DDL fails the suite at `beforeAll`.
 *
 * The suite skips itself when no server is reachable, so `bun test` stays
 * green on a machine without one. Start the fleet with:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 */

const CONNECTION =
  process.env.MYSQL_URL ||
  "mysql://stabilize:stabilize@127.0.0.1:53306/stabilize_test";

/** True when a MySQL answers; decides whether the suite runs or skips. */
async function probe(): Promise<boolean> {
  const pool = mysql.createPool(CONNECTION);
  try {
    await pool.query("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  } finally {
    // `end()` on a pool that never connected can still reject; the probe's
    // answer is already known by then, so the teardown failure is not worth
    // surfacing.
    await pool.end().catch(() => {});
  }
}

const available = await probe();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `[skip] No MySQL at ${CONNECTION}. Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

const User = defineModel({
  tableName: "my_users",
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
  tableName: "my_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    // `unique` is load-bearing, and the reason differs from PostgreSQL's. A
    // `UNIQUE` column is also what makes `autoMigrate` emit the second DDL
    // statement a MySQL target needs — an index it creates itself rather than
    // a constraint the server derives — which is the path the schema case
    // below covers. At runtime, Postgres's `ON CONFLICT (title)` names its
    // conflict target and the server looks up a unique index to match it
    // against; MySQL's `ON DUPLICATE KEY UPDATE` has no target clause at all
    // and fires on a violation of *any* unique or primary key. With no unique
    // index on `title` there is nothing for a second insert to violate, so the
    // upsert would silently degrade into a plain INSERT and duplicate the row.
    title: { type: DataTypes.STRING, required: true, unique: true },
    body: { type: DataTypes.TEXT },
    published: { type: DataTypes.BOOLEAN },
    meta: { type: DataTypes.JSON },
    score: { type: DataTypes.DECIMAL },
    createdAt: { type: DataTypes.DATETIME },
  },
});

/** Every table this suite creates, so a re-run starts from a clean schema. */
const TABLES = ["my_users_history", "my_posts_history", "my_users", "my_posts"];

/**
 * Runs `work` and returns the error it rejected with, or `undefined` if it
 * resolved. Awaits, so it always settles.
 *
 * Deliberately not `await expect(promise).rejects.toThrow(...)`. Under
 * `bun test` that form can hang until the runner's timeout when the rejection
 * has travelled through a database driver's own async machinery — mysql2 hops
 * through `setImmediate` internally — leaving the statement in flight and the
 * connection checked out, and the run then tears down with the pool still
 * open. The try/catch asserts exactly the same thing and always settles.
 * Every negative case in this file goes through here.
 */
async function caught(work: () => Promise<unknown>): Promise<any> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

suite("MySQL integration", () => {
  let db: any;
  let repo: any;
  let postRepo: any;

  beforeAll(async () => {
    // Start from a clean schema: a previous run's rows would collide with the
    // unique-constraint and count assertions below.
    const reset = mysql.createPool(CONNECTION);
    for (const table of TABLES) {
      await reset.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await reset.end();

    db = new Stabilize({ type: DBType.MySQL, connectionString: CONNECTION });
    // Not wrapped in a try/catch: the migration *is* what several of the cases
    // below are about, and letting it escape fails the suite loudly instead of
    // leaving the rest of the file to run against a schema that is not there.
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
    expect(health.database).toBe("mysql");
  });

  it("autoMigrate builds the schema on MySQL", async () => {
    // The whole `CREATE TABLE` path, which is only reachable on this server if
    // every identifier in it was quoted with a backtick: MySQL reads `"x"` as
    // a string literal unless `ANSI_QUOTES` is in `sql_mode`, and the stock
    // server does not set it.
    //
    // `DATABASE()` rather than a hard-coded schema name: the pool connects
    // straight to the database named in the connection string, so this follows
    // a `MYSQL_URL` override instead of silently matching nothing.
    const tables = await db.client.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'my_%'",
    );
    expect(tables.map((t: any) => t.name).sort()).toEqual([
      "my_posts",
      "my_users",
    ]);

    // The index half of the DDL, which takes a different statement from the
    // other dialects: MySQL has no `IF NOT EXISTS` clause on `CREATE INDEX`,
    // so this index exists only if the untargeted form was emitted. Asserting
    // the name is what separates "it was created" from "the CREATE TABLE
    // happened to carry a UNIQUE constraint with the server's own name".
    const indexes = await db.client.query(
      "SELECT DISTINCT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'my_posts'",
    );
    expect(indexes.map((i: any) => i.name)).toContain("my_posts_title_uniq");
  });

  it("autoMigrate is idempotent against information_schema", async () => {
    // The tables exist by now, so this takes the "add missing columns" branch
    // rather than the CREATE TABLE one, and — because the index created above
    // is already listed — it must find every index present and emit no
    // `CREATE INDEX` at all. On MySQL that check is the *only* thing standing
    // between a second run and a duplicate-key error, since the statement
    // itself carries no guard.
    await db.autoMigrate([User, Post]);

    const tables = await db.client.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'my_%'",
    );
    expect(tables.map((t: any) => t.name).sort()).toEqual([
      "my_posts",
      "my_users",
    ]);
  });

  it("inserts a row and returns it with a generated key", async () => {
    // MySQL has no `RETURNING *`; the driver reads `LAST_INSERT_ID()` back off
    // the connection that ran the INSERT and issues a follow-up SELECT. If
    // either half were missing the `id` would come back undefined.
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
    // `my_users` declares `deleted_at`, so this is the soft-delete write: an
    // `UPDATE` whose bound timestamp has to be in the one spelling MySQL's
    // `DATETIME` accepts. The ISO-8601 form the other dialects take is
    // rejected here with ER_TRUNCATED_WRONG_VALUE.
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
    // MySQL has no `BOOLEAN`; the dialect maps it to `TINYINT(1)`, which
    // `mysql2` returns as a number, not a boolean. Comparing to `true` here
    // would fail on `1`, so the value is coerced first.
    expect(Boolean(found.published)).toBe(true);
    // `DECIMAL` comes back as a string from `mysql2` to avoid a lossy float
    // conversion, so this compares numerically rather than by type. The same
    // trap exists on PostgreSQL.
    expect(Number(found.score)).toBeCloseTo(12.5);
    // MySQL's `JSON` is a real type, so the driver parses the column back into
    // a value on read — no `JSON.parse` needed here, unlike MariaDB's alias.
    expect(found.meta).toEqual({ tags: ["a", "b"] });
  });

  it("round-trips a JSON column as a real object", async () => {
    // Both halves have to work for this. On the write side the object is bound
    // as JSON text: `mysql2` rewrites a plain object parameter into an
    // assignment list (`` `nested` = 1 ``), which is meaningless inside a
    // `VALUES` clause and fails the statement outright. On the read side the
    // driver parses a `JSON` column back into an object. If either half were
    // missing the column would be unwritable, or come back as a string.
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

    const thrown = await caught(() =>
      db.transaction(async (tx: any) => {
        await repo.create({ name: "rolled-back", email: "rb@x.com" }, {}, tx);
        throw new Error("boom");
      }),
    );
    // @see `caught` for why this is not `.rejects.toThrow`.
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

    const error = await caught(() =>
      repo.create({ name: "unique-two", email: "dup@x.com" }),
    );
    expect(error?.message).toMatch(/Duplicate entry/i);
  });

  it("soft deletes, hides from queries and recovers", async () => {
    const created: any = await repo.create({ name: "soft", email: "soft@x.com" });

    await repo.delete(created.id);
    expect(await repo.findOne(created.id)).toBeNull();

    await repo.recover(created.id);
    expect((await repo.findOne(created.id))?.name).toBe("soft");
  });

  it("upserts through ON DUPLICATE KEY", async () => {
    await postRepo.create({ title: "upsert-me", body: "first" });

    const result: any = await postRepo.upsert(
      { title: "upsert-me", body: "second" },
      ["title"],
    );

    expect(result).toBeDefined();

    // The unique key must have been violated and updated in place. If the
    // `ON DUPLICATE KEY` clause were wrong, or the conflict key not actually
    // unique, this is where a duplicate appears.
    const found = await postRepo.findBy({ title: "upsert-me" });
    expect(found.length).toBe(1);
    expect((found[0] as any).body).toBe("second");
  });

  it("deletes rows in bulk and hides them from queries", async () => {
    // `bulkDelete` reaches the same soft-delete UPDATE as `delete`, one row at
    // a time, so it needs the same timestamp spelling.
    const first: any = await repo.create({ name: "bulk-a", email: "bulka@x.com" });
    const second: any = await repo.create({ name: "bulk-b", email: "bulkb@x.com" });

    await repo.bulkDelete([first.id, second.id]);

    expect(await repo.findOne(first.id)).toBeNull();
    expect(await repo.findOne(second.id)).toBeNull();
    expect((await repo.findBy({ name: "bulk-a" })).length).toBe(0);
  });

  it("soft deletes by condition in one statement", async () => {
    // The third soft-delete write, and the one that reaches widest: a single
    // UPDATE across every matching row rather than one id at a time, so it
    // needs the same timestamp spelling as the two above.
    await repo.create({ name: "by-cond-a", email: "bya@x.com" });
    await repo.create({ name: "by-cond-b", email: "byb@x.com" });

    const affected = await repo.deleteBy({ name: "by-cond-a" });

    expect(affected).toBe(1);
    expect((await repo.findBy({ name: "by-cond-a" })).length).toBe(0);
    expect((await repo.findBy({ name: "by-cond-b" })).length).toBe(1);
  });
});
