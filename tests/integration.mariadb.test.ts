import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * End-to-end coverage against a real MariaDB server.
 *
 * The MySQL dialect's SQL is unit-tested by asserting the string it produces,
 * but a string assertion can only prove we emitted what we intended. Whether
 * `?` parameters bind in order, whether `LAST_INSERT_ID()` really hands back
 * the generated key, whether `ON DUPLICATE KEY UPDATE` updates in place —
 * only a server can settle those. That is what this file is for, and it is
 * the MySQL-dialect file plus a set of cases that exist *because MariaDB is
 * not MySQL*; those are marked `MariaDB:` below.
 *
 * Where MariaDB differs from MySQL 8, the difference is usually one that a
 * naive dialect check gets wrong: the version string, a `JSON` column that is
 * really `LONGTEXT`, a server that accepts `INSERT … RETURNING` the dialect
 * never emits. The suite pins those so a change made for one MySQL-family
 * server is not silently made against the other's behaviour.
 *
 * The suite skips itself when no server is reachable, so `bun test` stays
 * green on a machine without one. Start the fleet with:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 */

const CONNECTION =
  process.env.MARIADB_URL ||
  "mysql://stabilize:stabilize@127.0.0.1:53307/stabilize_test";

/** Every table this suite creates, so a re-run starts from a clean schema. */
const TABLES = [
  "maria_users_history",
  "maria_posts_history",
  "maria_types_history",
  "maria_users",
  "maria_posts",
  "maria_types",
];

/** True when a MariaDB answers; decides whether the suite runs or skips. */
async function probe(): Promise<boolean> {
  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      uri: CONNECTION,
      connectTimeout: 3000,
    });
    await connection.query("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  } finally {
    // `end()` on a connection that never opened rejects; the probe's answer
    // is already known by then, so the teardown failure is not worth surfacing.
    await connection?.end().catch(() => {});
  }
}

const available = await probe();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `[skip] No MariaDB at ${CONNECTION}. Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

const User = defineModel({
  tableName: "maria_users",
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
  tableName: "maria_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    // Unique, which the Postgres twin needs for a different reason: Postgres
    // names its conflict target (`ON CONFLICT (title)`) and fails loudly when
    // no unique constraint backs it; MySQL's `ON DUPLICATE KEY UPDATE` names
    // no target and fires on *any* unique key, so without this index the
    // "upsert" would silently append a second row instead of updating the
    // first.
    title: { type: DataTypes.STRING, required: true, unique: true },
    body: { type: DataTypes.TEXT },
    published: { type: DataTypes.BOOLEAN },
    meta: { type: DataTypes.JSON },
    score: { type: DataTypes.DECIMAL },
    createdAt: { type: DataTypes.DATETIME },
  },
});

/** One column per mapped `DataTypes` member, to prove each survives a trip. */
const Typed = defineModel({
  tableName: "maria_types",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    s: { type: DataTypes.STRING },
    t: { type: DataTypes.TEXT },
    i: { type: DataTypes.INTEGER },
    bi: { type: DataTypes.BIGINT },
    f: { type: DataTypes.FLOAT },
    d: { type: DataTypes.DOUBLE },
    // Not `dec`: `DEC` is a reserved word in MariaDB (a synonym for DECIMAL),
    // so an unquoted `dec` in a column list is a syntax error. `autoMigrate`
    // backticks the identifiers in its DDL, but the runtime query paths
    // (`repository.ts`, `query-builder.ts`) build column lists bare, which
    // makes the reserved-word set part of the dialect's real contract.
    num: { type: DataTypes.DECIMAL },
    b: { type: DataTypes.BOOLEAN },
    dt: { type: DataTypes.DATE },
    ts: { type: DataTypes.DATETIME },
    j: { type: DataTypes.JSON },
    u: { type: DataTypes.UUID },
    payload: { type: DataTypes.BLOB },
  },
});

/**
 * Reads the local-time components of a value the driver handed back.
 *
 * `mysql2` parses `DATE` and `DATETIME` columns into a `Date` built from the
 * literal digits in the column, using the *local* zone — not UTC. Comparing
 * through `toISOString()` would therefore shift by the machine's offset and
 * produce a test that passes in one timezone and fails in another.
 */
function localParts(value: any): number[] {
  const d = value instanceof Date ? value : new Date(value);
  return [
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ];
}

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

suite("MariaDB integration", () => {
  let db: any;
  let repo: any;
  let postRepo: any;
  let typedRepo: any;

  beforeAll(async () => {
    // Start from a clean schema: a previous run's rows would collide with the
    // unique-constraint and count assertions below.
    const reset = await mysql.createConnection({ uri: CONNECTION });
    for (const table of TABLES) {
      await reset.query(`DROP TABLE IF EXISTS \`${table}\``);
    }

    db = new Stabilize({ type: DBType.MySQL, connectionString: CONNECTION });
    // Not wrapped in a try/catch: the migration is what the schema case below
    // is about, and letting it escape fails the suite loudly rather than
    // leaving the rest of the file to run against a schema that is not there.
    await db.autoMigrate([User, Post, Typed]);

    repo = db.getRepository(User);
    postRepo = db.getRepository(Post);
    typedRepo = db.getRepository(Typed);

    await reset.end();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("connects and reports a health check", async () => {
    const health = await db.healthCheck();
    expect(health.status).toBe("healthy");
    // The library has no MariaDB entry in `DBType` — it reaches this server
    // through the MySQL driver, so the dialect (and therefore every branch
    // keyed off `config.type`) reports "mysql".
    expect(health.database).toBe("mysql");
  });

  it("MariaDB: reports a MariaDB version string, not a MySQL one", async () => {
    // The reason a separate suite exists at all. Any dialect check that keys
    // off the server version — "MySQL 8 supports X" — sees a different string
    // here, and a naive `startsWith("8.")` or `includes("MySQL")` would take
    // the wrong branch. Asserting the shape documents what such a check faces.
    const rows = await db.client.query("SELECT VERSION() AS version");
    const version: string = rows[0].version;
    expect(version).toContain("MariaDB");
  });

  it("autoMigrate creates the schema", async () => {
    // Running it a second time must not throw. Here that is a real claim
    // rather than a formality: MySQL and MariaDB have no `IF NOT EXISTS`
    // clause to put on a `CREATE INDEX`, so the second run is only harmless
    // because the dialect checks `SHOW INDEX` first and emits nothing.
    await db.autoMigrate([User, Post, Typed]);

    const tables = await db.client.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'maria\\_%'",
    );
    expect(tables.map((t: any) => t.name).sort()).toEqual([
      "maria_posts",
      "maria_types",
      "maria_users",
    ]);
  });

  it("inserts a row and returns it with a generated key", async () => {
    // MySQL has no `RETURNING`, so the generated `id` arrives by a second
    // round trip through `SELECT LAST_INSERT_ID()`. That statement is the
    // only reason this works here, and MariaDB implements it.
    const created: any = await repo.create({ name: "Ada", email: "ada@x.com" });

    expect(created).toBeTruthy();
    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe("Ada");
  });

  it("MariaDB: the server does support INSERT ... RETURNING, but the dialect does not use it", async () => {
    // MariaDB accepts `INSERT ... RETURNING` (MySQL does not), so the dialect
    // *could* take the Postgres path here. It does not — the repository keeps
    // the MySQL branch, uses `ON DUPLICATE KEY UPDATE` and reads the key back
    // with `LAST_INSERT_ID()`. Proving both halves matters: the server feature
    // is real, and the fallback still works, so a future change that branches
    // on `SELECT VERSION()` has a working target either way.
    const rows = await db.client.query(
      "INSERT INTO maria_posts (title, body) VALUES (?, ?) RETURNING id, title",
      ["returning-probe", "x"],
    );
    expect(rows[0].title).toBe("returning-probe");
    expect(Number(rows[0].id)).toBeGreaterThan(0);

    await db.client.query("DELETE FROM maria_posts WHERE title = ?", [
      "returning-probe",
    ]);
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
    // `maria_users` declares `deleted_at`, so this is the soft-delete write:
    // an `UPDATE` whose bound timestamp has to be in the one spelling the
    // MySQL family's `DATETIME` accepts. The ISO-8601 form the other dialects
    // take is rejected here with ER_TRUNCATED_WRONG_VALUE.
    const created: any = await repo.create({ name: "temp", email: "temp@x.com" });
    await repo.delete(created.id);
    expect(await repo.findOne(created.id)).toBeNull();
  });

  it("deletes a row outright when the model declares no soft-delete column", async () => {
    // The other branch of `_delete`: `maria_posts` has no `deleted_at`, so the
    // row is really removed rather than flagged.
    const created: any = await postRepo.create({ title: "hard-delete", body: "x" });
    await postRepo.delete(created.id);

    expect(await postRepo.findOne(created.id)).toBeNull();
    const rows = await db.client.query(
      "SELECT id FROM maria_posts WHERE id = ?",
      [created.id],
    );
    expect(rows.length).toBe(0);
  });

  it("stores and reads back every mapped column type", async () => {
    const created: any = await typedRepo.create({
      s: "varchar",
      t: "long text",
      i: 42,
      bi: 9007199254,
      f: 1.5,
      d: 2.25,
      num: 12.5,
      b: true,
      dt: "2024-01-15",
      ts: "2024-01-15 10:30:00",
      j: { nested: [1, 2] },
      u: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      payload: Buffer.from("bytes"),
    });

    const found: any = await typedRepo.findOne(created.id);

    expect(found.s).toBe("varchar");
    expect(found.t).toBe("long text");
    expect(found.i).toBe(42);
    // MySQL hands `BIGINT` back as a JS number, not a string. The value fits
    // in a double, so an exact compare is safe at this magnitude.
    expect(Number(found.bi)).toBe(9007199254);
    expect(Number(found.f)).toBeCloseTo(1.5);
    expect(Number(found.d)).toBeCloseTo(2.25);
    // `DECIMAL` comes back as a string — mysql2 will not turn a fixed-point
    // value into a lossy float on its own — so this compares numerically.
    expect(Number(found.num)).toBeCloseTo(12.5);
    // There is no real `BOOLEAN` in either MySQL or MariaDB: the dialect maps
    // it to `TINYINT(1)`, which the driver hands back as the *number* 1 or 0.
    // Comparing to `true` would fail; the column is only boolean by convention.
    expect(Boolean(found.b)).toBe(true);
    expect(localParts(found.dt).slice(0, 3)).toEqual([2024, 1, 15]);
    expect(localParts(found.ts).slice(0, 5)).toEqual([2024, 1, 15, 10, 30]);
    // `UUID` maps to `CHAR(36)` — there is no native type — so it round-trips
    // as the plain string it was given.
    expect(found.u).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(Buffer.isBuffer(found.payload)).toBe(true);
    expect(found.payload.toString()).toBe("bytes");
  });

  it("round-trips a JSON column written as an object", async () => {
    // MariaDB stores a `JSON` column as `LONGTEXT` with a `CHECK(json_valid())`
    // — an alias, not the distinct type MySQL 8 has. The driver therefore sees
    // a text column and hands back the raw string, where on MySQL it would
    // have parsed the value into an object. The value survives either way;
    // only its JS type differs, so this asserts the MariaDB half explicitly
    // and parses before comparing. @see the information_schema case below.
    const created: any = await postRepo.create({
      title: "json",
      meta: { nested: { deep: [1, 2, 3] }, flag: false },
    });

    const found: any = await postRepo.findOne(created.id);
    expect(typeof found.meta).toBe("string");

    const meta =
      typeof found.meta === "string" ? JSON.parse(found.meta) : found.meta;
    expect(meta).toEqual({ nested: { deep: [1, 2, 3] }, flag: false });
  });

  it("MariaDB: a JSON column is reported as longtext, not as a JSON type", async () => {
    // The alias is observable in `information_schema`, which is exactly where
    // a MySQL-flavoured schema inspection goes wrong: code looking for
    // `data_type = 'json'` finds nothing here, and code that branches on
    // "is this column JSON" silently takes the text path.
    const rows = await db.client.query(
      "SELECT data_type AS type, column_type AS columnType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'maria_posts' AND column_name = 'meta'",
    );
    expect(rows[0].type).toBe("longtext");
    expect(rows[0].columnType).toBe("longtext");
  });

  it("MariaDB: a JSON column still rejects invalid JSON", async () => {
    // MariaDB is widely described as *not* enforcing JSON validity the way
    // MySQL's native type does, but 11.x attaches `CHECK (json_valid(...))` to
    // the alias. This asserts the server's actual behaviour rather than the
    // folklore, so a future MariaDB that drops the check is noticed here.
    const error = await caught(() =>
      db.client.query("INSERT INTO maria_posts (title, meta) VALUES (?, ?)", [
        "bad-json",
        "not json at all",
      ]),
    );
    expect(error).toBeDefined();
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

  it("upserts through ON DUPLICATE KEY UPDATE", async () => {
    await postRepo.create({ title: "upsert-me", body: "first" });

    const result: any = await postRepo.upsert(
      { title: "upsert-me", body: "second" },
      ["title"],
    );

    expect(result).toBeDefined();

    // The duplicate key must have matched and updated in place. Unlike
    // Postgres's named conflict target, `ON DUPLICATE KEY UPDATE` fires on
    // *any* unique key, so the row count is the only proof that `title`'s
    // index — and not some other one — is what the clause collided against.
    const found = await postRepo.findBy({ title: "upsert-me" });
    expect(found.length).toBe(1);
    expect((found[0] as any).body).toBe("second");
  });

  it("bulk deletes and soft deletes by condition", async () => {
    // The other two soft-delete writes. Both bind the same timestamp as
    // `delete()` does; `bulkDelete` does it one id at a time, `deleteBy` in a
    // single UPDATE across every matching row.
    const first: any = await repo.create({ name: "bulk-a", email: "bulka@x.com" });
    const second: any = await repo.create({ name: "bulk-b", email: "bulkb@x.com" });
    await repo.create({ name: "by-cond", email: "bycond@x.com" });

    await repo.bulkDelete([first.id, second.id]);
    const affected = await repo.deleteBy({ name: "by-cond" });

    expect(affected).toBe(1);
    expect(await repo.findOne(first.id)).toBeNull();
    expect(await repo.findOne(second.id)).toBeNull();
    expect((await repo.findBy({ name: "by-cond" })).length).toBe(0);
  });

  it("MariaDB: DATETIME takes a CURRENT_TIMESTAMP default, and ON UPDATE works", async () => {
    // MySQL's older rule — one `TIMESTAMP` column per table may default to
    // `CURRENT_TIMESTAMP` — is why the generator puts `DEFAULT
    // CURRENT_TIMESTAMP` on `DATETIME` rather than `TIMESTAMP`. MariaDB
    // relaxes that rule, but the shipped spelling has to parse on both, so
    // assert the DDL works and that the server actually fills the column in.
    await db.client.query("DROP TABLE IF EXISTS maria_datetime_probe");
    await db.client.query(
      "CREATE TABLE maria_datetime_probe (" +
        "id INT AUTO_INCREMENT PRIMARY KEY, " +
        "createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, " +
        "updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)",
    );

    await db.client.query("INSERT INTO maria_datetime_probe () VALUES ()");
    const rows = await db.client.query(
      "SELECT createdAt, updatedAt FROM maria_datetime_probe",
    );
    // The driver hands both back as `Date`s; a null means the default never
    // applied, which is the failure this case is watching for.
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows[0].updatedAt).toBeInstanceOf(Date);

    await db.client.query("DROP TABLE maria_datetime_probe");
  });
});
