import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";
import { decrypt } from "../utils/encryption";

/**
 * End-to-end coverage for the write paths that are only observable against a
 * real database: lifecycle hooks, `bulkCreate` and `upsert`.
 *
 * Each case here is a bug that a fake client could not expose — the hooks ran
 * against objects with no model prototype, `bulkCreate` guessed which rows it
 * had inserted, and `upsert` resolved its id from a value that describes an
 * unrelated statement.
 */

/** Records every hook invocation so the tests can assert on ordering. */
const calls: string[] = [];

const Doc = defineModel({
  tableName: "hooked_docs",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    // Deliberately required and deliberately never supplied by the caller: the
    // `beforeCreate` hook is what fills it in.
    slug: { type: DataTypes.STRING, required: true },
    tag: { type: DataTypes.STRING },
  },
  hooks: {
    beforeCreate: (entity: any) => {
      entity.slug = String(entity.title).toLowerCase().replace(/\s+/g, "-");
    },
    afterCreate: (entity: any) => {
      calls.push(`afterCreate:${entity.id}`);
    },
    beforeUpdate: (entity: any) => {
      calls.push(`beforeUpdate:${entity.id}`);
      entity.tag = `${entity.tag}-touched`;
    },
    afterSave: (entity: any) => {
      calls.push(`afterSave:${entity.id}`);
    },
    beforeDelete: (entity: any) => {
      calls.push(`beforeDelete:${entity.id}`);
    },
    afterDelete: (entity: any) => {
      calls.push(`afterDelete:${entity.id}`);
    },
  },
});

// A hook declared as a class method rather than in the config. It only
// resolves on a real model instance, which is what `hydrate` provides.
(Doc.prototype as any).afterUpdate = function () {
  calls.push(`methodAfterUpdate:${this.id}`);
};

const Account = defineModel({
  tableName: "upserted_accounts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    email: { type: DataTypes.STRING, unique: true },
    name: { type: DataTypes.STRING },
    nickname: { type: DataTypes.STRING },
  },
});

const Secret = defineModel({
  tableName: "bulk_secrets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING },
    ssn: { type: DataTypes.STRING, encrypted: true },
  },
});

/** Timestamps, an optimistic lock and both bulk operations. */
const Note = defineModel({
  tableName: "notes",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    body: { type: DataTypes.STRING },
    rev: { type: DataTypes.INTEGER, optimisticLock: true },
    createdAt: { type: DataTypes.DATETIME },
    updatedAt: { type: DataTypes.DATETIME },
  },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
});

describe("write path integration", () => {
  let db: any;

  const rows = (qb: any) => qb.execute(db.client);

  beforeAll(async () => {
    // Encrypted columns need a key; there is no hard-coded fallback.
    process.env.ORM_ENCRYPTION_KEY = "test-key-32-bytes-long-padding!!";
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Doc, Account, Secret]);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("persists what a beforeCreate hook wrote", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "Hello World" });

    // The hook supplied `slug`, which is required — validation runs after the
    // hooks, so the insert succeeds and the value is actually written.
    expect(created.slug).toBe("hello-world");
    expect((await repo.findOne(created.id))?.slug).toBe("hello-world");

    const raw = await db.client.query(
      "SELECT slug FROM hooked_docs WHERE id = ?",
      [created.id],
    );
    expect(raw[0].slug).toBe("hello-world");
  });

  it("runs afterCreate and afterSave with the created entity", async () => {
    const repo = db.getRepository(Doc);
    calls.length = 0;

    const created: any = await repo.create({ title: "Second" });

    expect(calls).toContain(`afterCreate:${created.id}`);
    expect(calls).toContain(`afterSave:${created.id}`);
  });

  it("runs beforeUpdate, the class-method afterUpdate and afterSave on update", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "Third", tag: "x" });
    calls.length = 0;

    const updated: any = await repo.update(created.id, { title: "Third!" });

    expect(calls).toContain(`beforeUpdate:${created.id}`);
    expect(calls).toContain(`afterSave:${created.id}`);
    expect(calls).toContain(`methodAfterUpdate:${created.id}`);
    // The beforeUpdate mutation has to reach the database.
    expect(updated.tag).toBe("x-touched");
  });

  it("runs the delete hooks", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "Fourth" });
    calls.length = 0;

    await repo.delete(created.id);

    expect(calls).toContain(`beforeDelete:${created.id}`);
    expect(calls).toContain(`afterDelete:${created.id}`);
  });

  it("writes every column of a bulk batch, not just the first row's", async () => {
    const repo = db.getRepository(Doc);
    calls.length = 0;

    const created = await repo.bulkCreate([
      { title: "narrow", slug: "narrow" },
      { title: "wide", slug: "wide", tag: "kept" },
    ]);

    // The second row carries a column the first does not. Deriving the column
    // list from `batch[0]` used to drop it silently.
    const wide = created.find((doc: any) => doc.title === "wide");
    expect(wide?.tag).toBe("kept");

    const raw = await db.client.query(
      "SELECT tag FROM hooked_docs WHERE title = ?",
      ["wide"],
    );
    expect(raw[0].tag).toBe("kept");
  });

  it("returns the rows a bulk insert actually created", async () => {
    const repo = db.getRepository(Doc);
    const created = await repo.bulkCreate([
      { title: "a1", slug: "a1" },
      { title: "a2", slug: "a2" },
      { title: "a3", slug: "a3" },
    ]);

    expect(created).toHaveLength(3);
    expect(created.map((doc: any) => doc.title)).toEqual(["a1", "a2", "a3"]);

    // Every returned id must be a row that holds the matching value, which is
    // what `ORDER BY id DESC LIMIT n` failed to guarantee.
    for (const doc of created) {
      const raw = await db.client.query(
        "SELECT title FROM hooked_docs WHERE id = ?",
        [doc.id],
      );
      expect(raw[0].title).toBe(doc.title);
    }
  });

  it("returns the row an upsert actually wrote", async () => {
    const repo = db.getRepository(Account);
    const first: any = await repo.upsert(
      { email: "a@example.com", name: "first" },
      ["email"],
    );

    // An unrelated insert moves the connection's last-inserted rowid, which is
    // what the old id resolution read back.
    await repo.create({ email: "b@example.com", name: "other" });

    const upserted: any = await repo.upsert(
      { email: "a@example.com", name: "second" },
      ["email"],
    );

    expect(upserted.id).toBe(first.id);
    expect(upserted.name).toBe("second");
    expect(upserted.email).toBe("a@example.com");

    const other = await repo.findOneBy({ email: "b@example.com" });
    expect(other?.name).toBe("other");
  });

  it("treats an upsert onto an existing key as an update", async () => {
    const repo = db.getRepository(Account);
    await repo.upsert({ email: "c@example.com", name: "one" }, ["email"]);
    const before = await repo.count();

    const second: any = await repo.upsert(
      { email: "c@example.com", name: "two" },
      ["email"],
    );

    expect(await repo.count()).toBe(before);
    expect(second.name).toBe("two");
    expect(await rows(repo.find())).toHaveLength(before);
  });

  it("encrypts a column written through bulkCreate", async () => {
    const repo = db.getRepository(Secret);
    await repo.bulkCreate([
      { label: "one", ssn: "111-11-1111" },
      { label: "two", ssn: "222-22-2222" },
    ]);

    const raw = await db.client.query(
      "SELECT label, ssn FROM bulk_secrets ORDER BY id ASC",
    );
    expect(raw[0].ssn).not.toBe("111-11-1111");
    expect(decrypt(raw[0].ssn)).toBe("111-11-1111");
    expect(decrypt(raw[1].ssn)).toBe("222-22-2222");
  });
});

describe("bulk operation guards", () => {
  let db: any;

  const rows = (qb: any) => qb.execute(db.client);

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Note]);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("advances updatedAt on updateBy", async () => {
    const repo = db.getRepository(Note);
    const created: any = await repo.create({ title: "one", body: "x" });

    // The clock is coarse enough that a same-millisecond write is possible.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const affected = await repo.updateBy({ title: "one" }, { body: "y" });

    expect(affected).toBe(1);
    const after: any = await repo.findOne(created.id);
    expect(after.body).toBe("y");
    expect(after.updatedAt).toBeTruthy();
    expect(after.updatedAt).not.toBe(created.updatedAt);
  });

  it("advances the optimistic lock on updateBy", async () => {
    const repo = db.getRepository(Note);
    const created: any = await repo.create({ title: "locked-here" });

    await repo.updateBy({ title: "locked-here" }, { body: "z" });

    const after: any = await repo.findOne(created.id);
    expect(after.rev).toBe(2);

    // The row must still be writable: a stale version would reject this.
    const updated: any = await repo.update(created.id, { body: "z2" });
    expect(updated.rev).toBe(3);
  });

  it("refuses updateBy with no conditions", async () => {
    const repo = db.getRepository(Note);
    await repo.create({ title: "survivor" });
    const before = await repo.count();

    await expect(repo.updateBy({}, { body: "wiped" })).rejects.toThrow(
      /at least one condition/i,
    );
    expect(await repo.count()).toBe(before);
    expect(await rows(repo.find())).toHaveLength(before);
  });

  it("refuses deleteBy with no conditions", async () => {
    const repo = db.getRepository(Note);
    const before = await repo.count();

    await expect(repo.deleteBy({})).rejects.toThrow(
      /at least one condition/i,
    );
    expect(await repo.count()).toBe(before);
  });

  it("deletes only the rows deleteBy matches", async () => {
    const repo = db.getRepository(Note);
    await repo.create({ title: "delete-me" });
    await repo.create({ title: "keep-me" });
    const before = await repo.count();

    const affected = await repo.deleteBy({ title: "delete-me" });

    expect(affected).toBe(1);
    expect(await repo.count()).toBe(before - 1);
    expect(await repo.exists({ title: "keep-me" })).toBe(true);
  });
});
