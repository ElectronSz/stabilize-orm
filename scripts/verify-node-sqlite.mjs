#!/usr/bin/env node
/**
 * @file verify-node-sqlite.mjs
 * @description End-to-end check that the packed package actually runs on Node
 *   as well as on Bun.
 *
 * This is the check that found the original defect. The package carried a
 * static `import { Database } from "bun:sqlite"`, the bundler inlined it, and
 * Node's ESM loader rejected the `bun:` scheme before a single connection was
 * opened — so PostgreSQL, MySQL, SQL Server and MongoDB were all unreachable on
 * Node because of a SQLite import.
 *
 * Run it against the **packed tarball**, never the working tree. A symlinked
 * `node_modules` is exactly how this class of defect stays hidden:
 *
 *   npm pack
 *   mkdir /tmp/verify && cd /tmp/verify
 *   npm install /path/to/stabilize-orm-<version>.tgz
 *   cp scripts/verify-node-sqlite.mjs .
 *   node verify-node-sqlite.mjs
 *   bun  verify-node-sqlite.mjs
 *
 * Exits non-zero if any check fails, so it can gate a release.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = process.versions.bun
  ? `bun ${process.versions.bun}`
  : `node ${process.versions.node}`;

let failed = 0;
let passed = 0;
const skipped = [];

/** Records one check and prints it as it happens. */
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Runs a check body, treating a throw as a failure rather than a crash. */
async function attempt(name, body) {
  try {
    await body();
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name} — threw ${error?.name}: ${error?.message}`);
  }
}

console.log(`\nstabilize-orm on ${runtime}\n`);

// ---------------------------------------------------------------- import ---
// Dynamic, so a failure to load is reported rather than killing the process
// with a stack trace — the import itself is the thing under test.
let Stabilize, defineModel, DataTypes, DBType, LogLevel;
try {
  const root = await import("stabilize-orm");
  ({ Stabilize } = root);
  ({ defineModel } = await import("stabilize-orm/model"));
  ({ DataTypes, DBType, LogLevel } = await import("stabilize-orm/types"));
  check("import stabilize-orm", typeof Stabilize === "function");
} catch (error) {
  console.log(`  FAIL  import stabilize-orm — ${error?.code}: ${error?.message}`);
  console.log(`\n1 failed. The package does not load on ${runtime}.\n`);
  process.exit(1);
}

const User = defineModel({
  tableName: "users",
  versioned: true,
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING, required: true, minLength: 2 },
    email: { type: DataTypes.STRING, unique: true },
    meta: { type: DataTypes.JSON },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
});

const config = (connectionString) => ({
  type: DBType.SQLite,
  connectionString,
});

/** Opens a client with ORM logging quietened — the third ctor argument. */
const open = (connectionString) =>
  new Stabilize(config(connectionString), {}, { level: LogLevel.Error });

// ------------------------------------------------- in-memory: the main path ---
console.log("\nin-memory");

let db, repo;
await attempt("open + autoMigrate (DDL, PRAGMA introspection)", async () => {
  db = open(":memory:");
  await db.autoMigrate([User]);
  repo = db.getRepository(User);
  check("open + autoMigrate (DDL, PRAGMA introspection)", true);
});

if (db) {
  await attempt("create returns the last_insert_rowid", async () => {
    const row = await repo.create({ name: "alice", email: "a@example.com" });
    check(
      "create returns the last_insert_rowid",
      row?.id === 1,
      `id was ${JSON.stringify(row?.id)}`,
    );
  });

  await attempt("findOne round-trips", async () => {
    const row = await repo.findOne(1);
    check(
      "findOne round-trips",
      row?.name === "alice" && row?.email === "a@example.com",
      `got ${JSON.stringify(row?.name)}`,
    );
  });

  await attempt("update advances the optimistic lock", async () => {
    const row = await repo.update(1, { name: "alice-2" });
    check(
      "update advances the optimistic lock",
      row?.version === 2,
      `version was ${JSON.stringify(row?.version)}`,
    );
  });

  await attempt("count and findBy", async () => {
    await repo.create({ name: "bob", email: "b@example.com" });
    const count = await repo.count();
    const found = await repo.findBy({ name: "bob" });
    check(
      "count and findBy",
      count === 2 && found.length === 1,
      `count=${count} findBy=${found.length}`,
    );
  });

  await attempt("JSON column stores text, not NULL", async () => {
    await repo.create({ name: "carol", meta: { nested: { deep: [1, 2] } } });
    // rawQuery bypasses the ORM's read path, so this sees what SQLite holds.
    const rows = await db.rawQuery(
      "SELECT meta AS value, typeof(meta) AS kind FROM users WHERE name = ?",
      ["carol"],
    );
    const cell = rows?.[0];
    const ok =
      cell?.kind === "text" &&
      JSON.stringify(JSON.parse(cell.value)) ===
        JSON.stringify({ nested: { deep: [1, 2] } });
    check("JSON column stores text, not NULL", ok, `stored ${cell?.kind}`);
  });

  await attempt("upsert (runs inside the SQLite transaction path)", async () => {
    await repo.upsert(
      { name: "dave", email: "d@example.com", meta: { v: 1 } },
      ["email"],
    );
    await repo.upsert(
      { name: "dave-renamed", email: "d@example.com", meta: { v: 2 } },
      ["email"],
    );
    const rows = await repo.findBy({ email: "d@example.com" });
    check(
      "upsert (runs inside the SQLite transaction path)",
      rows.length === 1 && rows[0].name === "dave-renamed",
      `${rows.length} rows, name=${JSON.stringify(rows[0]?.name)}`,
    );
  });

  await attempt("transaction rolls back every write", async () => {
    const before = await repo.count();
    let threw = false;
    try {
      await db.transaction(async (tx) => {
        await repo.create({ name: "rolled-back" }, {}, tx);
        throw new Error("boom");
      });
    } catch {
      threw = true;
    }
    const after = await repo.count();
    check(
      "transaction rolls back every write",
      threw && after === before,
      `threw=${threw} before=${before} after=${after}`,
    );
  });

  await attempt("transaction commits on success", async () => {
    await db.transaction(async (tx) => {
      await repo.create({ name: "committed" }, {}, tx);
    });
    const rows = await repo.findBy({ name: "committed" });
    check("transaction commits on success", rows.length === 1);
  });

  await attempt("delete removes the row", async () => {
    const row = await repo.create({ name: "ephemeral" });
    await repo.delete(row.id);
    check("delete removes the row", (await repo.findOne(row.id)) == null);
  });

  await db.close();
}

// --------------------------------------------------------- file-backed DB ---
// `bun:sqlite` needs `{ create: true }` to make a missing file; `node:sqlite`
// creates one on open and has no such option. Both must end up with a file.
console.log("\nfile-backed");

const dir = mkdtempSync(join(tmpdir(), "stabilize-verify-"));
const file = join(dir, "app.db");

await attempt("creates a missing database file", async () => {
  const fileDb = open(file);
  await fileDb.autoMigrate([User]);
  const fileRepo = fileDb.getRepository(User);
  await fileRepo.create({ name: "persisted" });
  const back = await fileRepo.findOne(1);
  await fileDb.close();
  check(
    "creates a missing database file",
    back?.name === "persisted",
    `read back ${JSON.stringify(back?.name)}`,
  );
});

await attempt("reopens an existing database file", async () => {
  const reopened = open(file);
  const rows = await reopened.rawQuery("SELECT name FROM users");
  await reopened.close();
  check(
    "reopens an existing database file",
    rows?.length === 1 && rows[0].name === "persisted",
    `${rows?.length} rows`,
  );
});

// Best-effort: on Windows the SQLite handle can outlive `close()` by a moment,
// and a locked temp directory is not a reason to fail the run.
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Left for the OS to reap.
}

/** Records a divergence that is inherent to a driver, not a regression. */
function note(text) {
  console.log(`  note  ${text}`);
}

// ----------------------------------------------------------- big integers ---
// Node's driver throws RangeError past 2^53 where Bun silently returns a lossy
// number. The adapter catches that and retries the read as bigint, so on Node a
// value comes back exact instead of truncated — and in range it stays a plain
// number on both runtimes. Bun's truncation is a property of `bun:sqlite` and is
// documented, not fixed: making it exact would turn every integer column into a
// bigint there.
console.log("\nlarge integers");

await attempt("in-range integer is a number, as on Bun", async () => {
  const small = open(":memory:");
  await small.rawQuery("CREATE TABLE n (v INTEGER)");
  await small.rawQuery("INSERT INTO n (v) VALUES (?)", [42]);
  const rows = await small.rawQuery("SELECT v FROM n");
  await small.close();
  check(
    "in-range integer is a number, as on Bun",
    rows?.[0]?.v === 42 && typeof rows[0].v === "number",
    `got ${typeof rows?.[0]?.v}`,
  );
});

await attempt("integer beyond 2^53", async () => {
  const big = open(":memory:");
  await big.rawQuery("CREATE TABLE n (v INTEGER)");
  // Bound as a string and cast, so the value never passes through a JS number.
  await big.rawQuery("INSERT INTO n (v) VALUES (CAST(? AS INTEGER))", [
    "9007199254740993",
  ]);
  const rows = await big.rawQuery("SELECT v FROM n");
  await big.close();
  const value = rows?.[0]?.v;

  if (process.versions.bun) {
    // Nothing to assert: this is the driver's known behaviour, reported so the
    // divergence is visible rather than mistaken for a pass.
    note(
      `bun:sqlite truncates past 2^53 — 9007199254740993 read back as ${String(value)}`,
    );
    return;
  }

  check(
    "integer beyond 2^53 comes back exact, not truncated",
    value === 9007199254740993n,
    `got ${String(value)} (${typeof value})`,
  );
});

// ------------------------------------------------------------------ summary ---
if (skipped.length) console.log(`\nskipped: ${skipped.join(", ")}`);
console.log(`\n${passed} passed, ${failed} failed on ${runtime}\n`);
process.exit(failed === 0 ? 0 : 1);
