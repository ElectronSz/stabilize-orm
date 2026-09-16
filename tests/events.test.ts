import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType, StabilizeEmitter, type StabilizeEvent } from "../types";

/**
 * Every name in the `StabilizeEvent` union is emitted by the library.
 *
 * Nine names were declared and two were fired — `connection:open` and
 * `connection:close`. The other seven were reserved: a handler registered for
 * `query`, `error`, `migration:start`, `migration:complete`,
 * `transaction:start`, `transaction:complete` or `transaction:error` was never
 * called, and nothing said so. These tests hold all nine to account.
 *
 * A third defect is covered here because it has no other symptom:
 * `Stabilize` built its client *before* its emitter and passed no emitter in,
 * so the client fired into an emitter of its own that no caller could reach.
 * Registering on the ORM heard the two connection events and nothing else.
 */

/** A model with enough shape to exercise DDL, reads, writes and versioning. */
const Note = defineModel({
  tableName: "event_notes",
  versioned: true,
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, length: 40 },
    meta: { type: DataTypes.JSON },
  },
});

/** Every member of the union, spelled out so a new one cannot slip in unlisted. */
const ALL_EVENTS: StabilizeEvent[] = [
  "query",
  "error",
  "migration:start",
  "migration:complete",
  "transaction:start",
  "transaction:complete",
  "transaction:error",
  "connection:open",
  "connection:close",
];

/** Collects every event a run produces, in order. */
function recorder() {
  const seen: { event: StabilizeEvent; payload: any }[] = [];

  return {
    seen,
    names: (): StabilizeEvent[] => seen.map((e) => e.event),
    payloads: (event: StabilizeEvent) =>
      seen.filter((e) => e.event === event).map((e) => e.payload),
    /** Registers one listener per event. */
    onAll(orm: any, events: StabilizeEvent[]) {
      for (const event of events) {
        orm.events.on(event, (payload: any) => seen.push({ event, payload }));
      }
    },
  };
}

/** Runs `fn`, swallowing a throw, for assertions against a live driver. */
async function settle(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // A `rejects` assertion against `bun:sqlite` hangs the runner rather than
    // failing it, so every expected failure in this file is caught by hand and
    // asserted on through the events it produced instead.
  }
}

describe("the event union and the implementation agree", () => {
  let db: any;
  let rec: ReturnType<typeof recorder>;

  beforeEach(() => {
    // The emitter is built first and handed in, which is the only way to hear
    // `connection:open`: it fires from the constructor.
    rec = recorder();
    const events = new StabilizeEmitter();
    rec.onAll({ events }, ALL_EVENTS);
    db = new Stabilize(
      { type: DBType.SQLite, connectionString: ":memory:" },
      { enabled: false, ttl: 60 },
      {},
      undefined,
      events,
    );
  });

  afterEach(async () => {
    await db?.close();
  });

  it("fires every name in the union across a normal lifecycle", async () => {
    await db.autoMigrate([Note]);
    const repo = db.getRepository(Note);
    await repo.create({ title: "hello", meta: { a: 1 } });
    await db.transaction(async (tx: any) => {
      await repo.create({ title: "in tx" }, {}, tx);
    });

    const fired = new Set(rec.names());
    // Three names are absent by design, each with its own test below:
    // `error` and `transaction:error` need a failure, and `connection:close`
    // needs the close that `afterEach` performs.
    const expected = ALL_EVENTS.filter(
      (e) =>
        e !== "error" && e !== "transaction:error" && e !== "connection:close",
    );

    for (const event of expected) {
      expect(fired.has(event), `${event} was never emitted`).toBe(true);
    }
  });

  it("emits connection:open at construction and connection:close on close", async () => {
    // `connection:open` fires before a handler registered on the ORM afterwards
    // could exist, so it is only observable through an injected emitter — the
    // fifth constructor argument, asserted here.
    expect(rec.payloads("connection:open")).toEqual([DBType.SQLite]);

    await db.close();

    expect(rec.payloads("connection:close")).toEqual([undefined]);
  });
});

describe("query events", () => {
  let db: any;
  let rec: ReturnType<typeof recorder>;

  beforeEach(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    rec = recorder();
    rec.onAll(db, ["query", "error"]);
    await db.autoMigrate([Note]);
  });

  afterEach(async () => {
    await db?.close();
  });

  it("reports each statement with its dialect, parameters and duration", async () => {
    const repo = db.getRepository(Note);
    await repo.create({ title: "reported" });

    const inserts = rec
      .payloads("query")
      .filter((p) => p.query.includes("INSERT INTO") && p.query.includes("event_notes"));

    expect(inserts.length).toBeGreaterThan(0);
    const [payload] = inserts;
    expect(payload.dbType).toBe(DBType.SQLite);
    expect(payload.params).toContain("reported");
    expect(typeof payload.executionTime).toBe("number");
  });

  it("reports statements run inside a transaction on the same emitter", async () => {
    // A transaction hands the callback a *second* client bound to one
    // connection. It has to share the emitter, or a subscriber sees every
    // statement except the ones inside a transaction.
    const repo = db.getRepository(Note);
    const before = rec.payloads("query").length;

    await db.transaction(async (tx: any) => {
      await repo.create({ title: "inside" }, {}, tx);
    });

    expect(rec.payloads("query").length).toBeGreaterThan(before);
  });

  it("reports a failed statement on error and not as a query", async () => {
    const before = rec.payloads("query").length;

    await settle(() => db.rawQuery("SELECT * FROM no_such_table_at_all"));

    expect(rec.payloads("query").length).toBe(before);
    const errors = rec.payloads("error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].phase).toBe("query");
    expect(errors[0].dbType).toBe(DBType.SQLite);
    expect(errors[0].attempt).toBe(1);
    expect(errors[0].error).toBeInstanceOf(Error);
  });
});

describe("transaction events", () => {
  let db: any;
  let rec: ReturnType<typeof recorder>;

  beforeEach(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    rec = recorder();
    rec.onAll(db, [
      "transaction:start",
      "transaction:complete",
      "transaction:error",
    ]);
    await db.autoMigrate([Note]);
  });

  afterEach(async () => {
    await db?.close();
  });

  it("brackets a committed transaction with start and complete", async () => {
    await db.transaction(async () => {});

    expect(rec.names()).toEqual(["transaction:start", "transaction:complete"]);
    expect(rec.payloads("transaction:start")).toEqual([
      { dbType: DBType.SQLite },
    ]);
  });

  it("reports a rolled-back transaction as an error, not a completion", async () => {
    const failure = new Error("rolled back on purpose");

    await settle(() =>
      db.transaction(async () => {
        throw failure;
      }),
    );

    expect(rec.names()).toEqual(["transaction:start", "transaction:error"]);
    // `phase` is present on every `error` payload, so a listener that filters
    // on it does not silently miss one of the three sources.
    expect(rec.payloads("transaction:error")).toEqual([
      { dbType: DBType.SQLite, phase: "transaction", error: failure },
    ]);
  });

  it("does not report a nested transaction as a second one", async () => {
    // The inner call runs its callback on the client it is already inside, so
    // no second transaction is opened and none is reported.
    await db.transaction(async (tx: any) => {
      await tx.transaction(async () => {});
    });

    expect(rec.payloads("transaction:start")).toHaveLength(1);
    expect(rec.payloads("transaction:complete")).toHaveLength(1);
  });
});

describe("migration events", () => {
  let db: any;
  let rec: ReturnType<typeof recorder>;

  beforeEach(() => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    rec = recorder();
    rec.onAll(db, [
      "migration:start",
      "migration:complete",
      "transaction:start",
      "transaction:complete",
      "query",
      "error",
    ]);
  });

  afterEach(async () => {
    await db?.close();
  });

  it("brackets each model autoMigrate reconciles, named by its table", async () => {
    await db.autoMigrate([Note]);

    expect(rec.payloads("migration:start")).toEqual([
      { dbType: DBType.SQLite, name: "event_notes", index: 0, total: 1 },
    ]);
    expect(rec.payloads("migration:complete")).toEqual([
      { dbType: DBType.SQLite, name: "event_notes", index: 0, total: 1 },
    ]);
  });

  it("reports position for a list, so progress through it is visible", async () => {
    const Second = defineModel({
      tableName: "event_seconds",
      columns: { id: { type: DataTypes.INTEGER, required: true } },
    });

    await db.autoMigrate([Note, Second]);

    expect(
      rec.payloads("migration:start").map((p) => [p.name, p.index, p.total]),
    ).toEqual([
      ["event_notes", 0, 2],
      ["event_seconds", 1, 2],
    ]);
  });

  it("brackets each migration run through migrate()", async () => {
    const orm = new Stabilize({
      type: DBType.SQLite,
      connectionString: ":memory:",
    });
    const run = recorder();
    run.onAll(orm, [
      "migration:start",
      "migration:complete",
      "transaction:start",
      "query",
    ]);

    try {
      await orm.migrate({ type: DBType.SQLite, connectionString: ":memory:" }, [
        {
          name: "001_create_things",
          up: ["CREATE TABLE things (id INTEGER PRIMARY KEY, label TEXT)"],
          down: ["DROP TABLE things"],
        },
      ]);
    } finally {
      await orm.close();
    }

    expect(run.payloads("migration:start")).toEqual([
      { dbType: DBType.SQLite, name: "001_create_things", index: 0, total: 1 },
    ]);
    expect(run.payloads("migration:complete")).toHaveLength(1);
    // The runner opens a connection of its own. If it does not share this
    // emitter, the migration reports itself while every statement it ran goes
    // unreported — which is exactly how the two emitters drifted apart.
    expect(run.payloads("transaction:start")).toHaveLength(1);
    expect(run.payloads("query").length).toBeGreaterThan(0);
  });

  it("does not report a migration the ledger already lists", async () => {
    // A file rather than `:memory:`, because the runner opens its own
    // connection on each call and the ledger has to outlive the first one.
    const file = join(tmpdir(), `stabilize-events-${Date.now()}.sqlite`);
    const config = { type: DBType.SQLite, connectionString: file };
    const migrations = [
      {
        name: "001_create_things",
        up: ["CREATE TABLE things (id INTEGER PRIMARY KEY, label TEXT)"],
        down: ["DROP TABLE things"],
      },
    ];

    const orm = new Stabilize(config);
    const run = recorder();
    run.onAll(orm, ["migration:start", "migration:complete"]);

    try {
      await orm.migrate(config, migrations);
      await orm.migrate(config, migrations);
    } finally {
      await orm.close();
      await unlink(file).catch(() => {});
    }

    expect(run.payloads("migration:start")).toHaveLength(1);
    expect(run.payloads("migration:complete")).toHaveLength(1);
  });

  it("reports a failed migration on error, leaving its start unpaired", async () => {
    const orm = new Stabilize({
      type: DBType.SQLite,
      connectionString: ":memory:",
    });
    const run = recorder();
    run.onAll(orm, ["migration:start", "migration:complete", "error"]);

    try {
      await settle(() =>
        orm.migrate({ type: DBType.SQLite, connectionString: ":memory:" }, [
          { name: "001_broken", up: ["THIS IS NOT SQL"], down: [] },
        ]),
      );
    } finally {
      await orm.close();
    }

    expect(run.payloads("migration:start")).toHaveLength(1);
    expect(run.payloads("migration:complete")).toHaveLength(0);
    // Two `error` events: the failing statement reports itself, and so does the
    // migration that was running when it failed. The phase tells them apart.
    expect(run.payloads("error").filter((p) => p.phase === "migration")).toHaveLength(1);
    expect(run.payloads("error").filter((p) => p.phase === "query").length)
      .toBeGreaterThan(0);
  });
});
