import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * A column declared as `firstName: { name: "first_name" }` is stored as
 * `first_name`, so every predicate the repository builds has to name the
 * *column*. Four lookup paths named the *property* instead — `findOneBy`,
 * `findBy`, `findMany({ where })` and `first` each pushed the raw key into
 * `whereNull`, so `findOneBy({ firstName: null })` rendered
 * `WHERE firstName IS NULL` and the database rejected the statement with
 * "no such column: firstName". A null lookup by property name was simply
 * unusable on a mapped column; the equality path next to it was not, which is
 * what made the failure look arbitrary.
 *
 * The models below rename every column they filter on. That is the only shape
 * that can expose the leak: when the property and the column happen to share a
 * name, the wrong one is still valid SQL and the bug is invisible.
 */

const Person = defineModel({
  tableName: "renamed_people",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    firstName: { type: DataTypes.STRING, name: "first_name" },
    lastName: { type: DataTypes.STRING, name: "last_name" },
    email: { type: DataTypes.STRING, name: "email_address", unique: true },
  },
});

/** A renamed soft-delete column, so the implicit `IS NULL` filter is renamed too. */
const Ticket = defineModel({
  tableName: "renamed_tickets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING },
    removedOn: { type: DataTypes.DATETIME, name: "removed_on", softDelete: true },
  },
});

/** A renamed sort key, exercised through the cursor branch of `findMany`. */
const Metric = defineModel({
  tableName: "renamed_metrics",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    seqNo: { type: DataTypes.INTEGER, name: "seq_no" },
    score: { type: DataTypes.INTEGER },
  },
});

describe("renamed columns", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Person, Ticket, Metric]);

    const people = db.getRepository(Person);
    // `firstName` is omitted, so the column is NULL — the row every
    // `{ firstName: null }` lookup below has to find.
    await people.create({ lastName: "Lovelace", email: "ada@example.com" });
    await people.create({
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
    });

    const tickets = db.getRepository(Ticket);
    await tickets.create({ title: "open" });
    await tickets.create({ title: "closed" });

    const metrics = db.getRepository(Metric);
    await metrics.create({ seqNo: 1, score: 10 });
    await metrics.create({ seqNo: 2, score: 20 });
    await metrics.create({ seqNo: 3, score: 30 });
  });

  afterAll(async () => {
    await db?.close();
  });

  it("stores the fixtures under the column name, not the property name", async () => {
    // Without this the rest of the file could pass vacuously: if `name` were
    // ignored, `first_name` would not exist and neither would the bug.
    const rows = await db.client.query(
      "SELECT first_name, email_address FROM renamed_people ORDER BY id",
    );
    expect(rows).toEqual([
      { first_name: null, email_address: "ada@example.com" },
      { first_name: "Grace", email_address: "grace@example.com" },
    ]);
  });

  it("has no column named after the property", async () => {
    // The direct proof that a pass below came from translating the property
    // rather than from the two names coinciding.
    let leaked = false;
    try {
      await db.client.query("SELECT firstName FROM renamed_people");
    } catch {
      leaked = true;
    }
    expect(leaked).toBe(true);
  });

  // ─── the four sites that named the property ────────────────────────
  //
  // Rows come back keyed by column name, which is the existing convention —
  // see `author_id` in integration.relations.test.ts.

  it("findOneBy resolves a null property to its column", async () => {
    const found = await db.getRepository(Person).findOneBy({ firstName: null });
    expect(found).not.toBeNull();
    expect(found.last_name).toBe("Lovelace");
    expect(found.first_name).toBeNull();
  });

  it("findBy resolves a null property to its column", async () => {
    const found = await db.getRepository(Person).findBy({ firstName: null });
    expect(found).toHaveLength(1);
    expect(found[0].last_name).toBe("Lovelace");
  });

  it("findMany resolves a null property to its column", async () => {
    const found = await db
      .getRepository(Person)
      .findMany({ where: { firstName: null } });
    expect(found).toHaveLength(1);
    expect(found[0].last_name).toBe("Lovelace");
  });

  it("first resolves a null property to its column", async () => {
    const found = await db.getRepository(Person).first({ firstName: null });
    expect(found).not.toBeNull();
    expect(found.last_name).toBe("Lovelace");
  });

  it("count resolves a null property to its column", async () => {
    // This one was already correct; it is here so the fix cannot quietly
    // regress into the same shape it just left.
    expect(await db.getRepository(Person).count({ firstName: null })).toBe(1);
  });

  // ─── the equality half, which has to keep working ──────────────────

  it("resolves a non-null property to its column on every lookup", async () => {
    const people = db.getRepository(Person);
    expect((await people.findOneBy({ firstName: "Grace" })).last_name).toBe(
      "Hopper",
    );
    expect(await people.findBy({ firstName: "Grace" })).toHaveLength(1);
    expect(
      await people.findMany({ where: { firstName: "Grace" } }),
    ).toHaveLength(1);
    expect((await people.first({ firstName: "Grace" })).last_name).toBe(
      "Hopper",
    );
    expect(await people.count({ firstName: "Grace" })).toBe(1);
  });

  it("finds nothing for a value no row holds", async () => {
    const people = db.getRepository(Person);
    expect(await people.findOneBy({ firstName: "Nobody" })).toBeNull();
    expect(await people.findBy({ firstName: "Nobody" })).toEqual([]);
  });

  it("plucks a renamed column by property name", async () => {
    const names = await db.getRepository(Person).pluck("firstName");
    expect(names).toEqual([null, "Grace"]);
  });

  // ─── renamed columns through the soft-delete filter ────────────────

  // Each of these seeds its own rows under a title of its own, so none of
  // them depends on what a neighbour left behind — the table is shared.

  it("filters and recovers on a renamed soft-delete column", async () => {
    const tickets = db.getRepository(Ticket);
    const open = await tickets.create({ title: "sd-open" });
    const closed = await tickets.create({ title: "sd-closed" });

    await tickets.delete(closed.id);
    expect(await tickets.findBy({ title: "sd-closed" })).toEqual([]);

    const deleted = await tickets.findDeleted().execute(db.client);
    expect(deleted.map((t: any) => t.title)).toContain("sd-closed");

    await tickets.recover(closed.id);
    expect(await tickets.findBy({ title: "sd-closed" })).toHaveLength(1);
    expect((await tickets.findOne(open.id)).title).toBe("sd-open");
  });

  it("counts only the rows the renamed soft-delete filter admits", async () => {
    const tickets = db.getRepository(Ticket);
    await tickets.create({ title: "cnt-keep" });
    const doomed = await tickets.create({ title: "cnt-doomed" });

    const before = await tickets.count();
    await tickets.delete(doomed.id);
    expect(await tickets.count()).toBe(before - 1);
  });

  it("deleteBy and restoreBy resolve a renamed condition", async () => {
    const tickets = db.getRepository(Ticket);
    await tickets.create({ title: "bulk-same" });
    await tickets.create({ title: "bulk-same" });

    expect(await tickets.deleteBy({ title: "bulk-same" })).toBe(2);
    expect(await tickets.findBy({ title: "bulk-same" })).toEqual([]);

    expect(await tickets.restoreBy({ title: "bulk-same" })).toBe(2);
    expect(await tickets.findBy({ title: "bulk-same" })).toHaveLength(2);
  });

  // ─── renamed columns through the cursor branch ─────────────────────

  it("pages by a renamed sort column", async () => {
    const metrics = db.getRepository(Metric);
    const page = await metrics.findMany({
      cursor: { field: "seqNo", value: 1 },
      orderBy: { field: "seqNo", direction: "ASC" },
      take: 10,
    });
    expect(page.map((m: any) => m.seq_no)).toEqual([2, 3]);
  });

  it("orders by a renamed column", async () => {
    const metrics = db.getRepository(Metric);
    const desc = await metrics.findMany({
      orderBy: { field: "seqNo", direction: "DESC" },
    });
    expect(desc.map((m: any) => m.seq_no)).toEqual([3, 2, 1]);
  });
});
