import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * End-to-end coverage against a real in-memory SQLite database.
 *
 * These exercise the paths that unit tests with fake clients cannot reach:
 * actual transaction control, constraint enforcement and the DDL emitted by
 * `autoMigrate`.
 */

const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING, required: true, minLength: 2 },
    email: { type: DataTypes.STRING, unique: true },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
    deleted_at: { type: DataTypes.DATETIME, softDelete: true },
  },
});

describe("in-memory SQLite integration", () => {
  let db: any;
  let repo: any;

  /** `find()` and friends return a builder; run one against the live client. */
  const rows = (qb: any) => qb.execute(db.client);

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([User]);
    repo = db.getRepository(User);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("rolls back every write when the transaction throws", async () => {
    const before = await repo.count();

    await expect(
      db.transaction(async (tx: any) => {
        await repo.create({ name: "rolled-back" }, {}, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The row must not have survived the rollback.
    expect(await repo.count()).toBe(before);
    expect(
      (await repo.findBy({ name: "rolled-back" })).length,
    ).toBe(0);
  });

  it("commits writes when the transaction succeeds", async () => {
    await db.transaction(async (tx: any) => {
      await repo.create({ name: "committed" }, {}, tx);
    });

    expect((await repo.findBy({ name: "committed" })).length).toBe(1);
  });

  it("rolls back a mix of create, update and delete together", async () => {
    const created: any = await repo.create({ name: "victim" });
    const idsBefore = (await rows(repo.find())).map((r: any) => r.id);

    await expect(
      db.transaction(async (tx: any) => {
        await repo.update(created.id, { name: "renamed" }, tx);
        await repo.create({ name: "bystander" }, {}, tx);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const after = await rows(repo.find());
    expect(after.map((r: any) => r.id)).toEqual(idsBefore);
    expect((await repo.findOne(created.id))?.name).toBe("victim");
  });

  it("seeds the optimistic lock on create and increments on update", async () => {
    const created: any = await repo.create({ name: "versioned" });

    expect(created.version).toBe(1);

    // The caller does not pass `version`; the lock must still advance.
    const updated: any = await repo.update(created.id, { name: "versioned-2" });
    expect(updated?.version).toBe(2);

    const again: any = await repo.update(created.id, { name: "versioned-3" });
    expect(again?.version).toBe(3);
  });

  it("rejects a create that fails validation", async () => {
    await expect(repo.create({ name: "A" })).rejects.toThrow("too short");
  });

  it("enforces a unique constraint", async () => {
    await repo.create({ name: "unique-one", email: "dup@example.com" });

    await expect(
      repo.create({ name: "unique-two", email: "dup@example.com" }),
    ).rejects.toThrow();
  });

  it("soft deletes, hides from queries and recovers", async () => {
    const created: any = await repo.create({ name: "soft" });

    await repo.delete(created.id);

    expect(await repo.findOne(created.id)).toBeNull();
    expect(
      (await rows(repo.findDeleted())).some((r: any) => r.id === created.id),
    ).toBe(true);
    expect(
      (await rows(repo.withTrashed())).some((r: any) => r.id === created.id),
    ).toBe(true);

    await repo.recover(created.id);
    expect((await repo.findOne(created.id))?.name).toBe("soft");
  });
});
