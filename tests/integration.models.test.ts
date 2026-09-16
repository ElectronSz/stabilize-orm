import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";
import { decrypt } from "../utils/encryption";

/**
 * Integration coverage for models that use the ORM's optional column
 * features: auto-managed timestamps, renamed soft-delete and lock columns,
 * encryption and version history.
 *
 * Each of these was broken in a way that only a real database exposes.
 */

/**
 * The README's timestamps pattern: declared in `columns` *and* `timestamps`.
 *
 * The table name is unique across the suite on purpose. `defineModel` writes
 * into a process-global registry that `getModelByTableName` reads by table
 * name, so two models sharing one table name collide and the last definition
 * silently wins for whichever test runs second.
 */
const Article = defineModel({
  tableName: "article_models",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    createdAt: { type: DataTypes.DATETIME },
    updatedAt: { type: DataTypes.DATETIME },
  },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
});

/** Soft-delete and lock columns whose SQL names differ from their keys. */
const Doc = defineModel({
  tableName: "docs",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    parentId: { type: DataTypes.INTEGER },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true, name: "deleted_at" },
    rev: { type: DataTypes.INTEGER, optimisticLock: true, name: "rev_no" },
  },
});

const Secret = defineModel({
  tableName: "secrets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING },
    ssn: { type: DataTypes.STRING, encrypted: true },
  },
});

const Account = defineModel({
  tableName: "accounts",
  versioned: true,
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING },
  },
});

describe("model feature integration", () => {
  let db: any;

  /** `findDeleted()` and friends return a builder; run one against the client. */
  const rows = (qb: any) => qb.execute(db.client);

  beforeAll(async () => {
    // Encrypted columns need a key. The ORM no longer falls back to a
    // hard-coded one, so the suite supplies its own.
    process.env.ORM_ENCRYPTION_KEY = "test-key-32-bytes-long-padding!!";
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Article, Doc, Secret, Account]);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("migrates a model whose timestamp columns are also declared in `columns`", async () => {
    // The DDL must not emit `createdAt` twice.
    const rows = await db.client.query("PRAGMA table_info(article_models)");
    const names = rows.map((r: any) => r.name);
    expect(names.filter((n: string) => n === "createdAt")).toHaveLength(1);
    expect(names.filter((n: string) => n === "updatedAt")).toHaveLength(1);
  });

  it("fills timestamps on create and refreshes updatedAt on update", async () => {
    const repo = db.getRepository(Article);
    const created: any = await repo.create({ title: "first" });

    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const updated: any = await repo.update(created.id, { title: "second" });
    expect(updated?.updatedAt).toBeTruthy();
    expect(updated?.createdAt).toBe(created.createdAt);
  });

  it("uses the mapped column name for soft delete everywhere", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "doc" });

    expect(await repo.count()).toBe(1);
    await repo.delete(created.id);

    expect(await repo.count()).toBe(0);
    expect(await repo.findOne(created.id)).toBeNull();
    expect(await rows(repo.findDeleted())).toHaveLength(1);

    await repo.recover(created.id);
    expect(await repo.count()).toBe(1);
  });

  it("uses the mapped column name for the optimistic lock", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "locked" });

    // The lock column is `rev_no`; the value must round-trip and advance.
    expect(created.rev_no ?? created.rev).toBe(1);

    const updated: any = await repo.update(created.id, { title: "locked-2" });
    expect(updated.rev_no ?? updated.rev).toBe(2);
  });

  it("throws CONCURRENT_MODIFICATION when the caller's version is stale", async () => {
    const repo = db.getRepository(Doc);
    const created: any = await repo.create({ title: "conflict" });

    // Someone else writes first.
    await repo.update(created.id, { title: "other-writer" });

    // Our caller still holds version 1.
    await expect(
      repo.update(created.id, { title: "mine", rev: 1 }),
    ).rejects.toThrow(/concurrent|modified by another/i);
  });

  it("treats a null condition as IS NULL in count and exists", async () => {
    const repo = db.getRepository(Doc);
    // This table is shared with the tests above, so compare against a delta
    // rather than assuming an empty table.
    const before = await repo.count({ parentId: null });

    await repo.create({ title: "with-parent", parentId: 7 });
    const orphan: any = await repo.create({ title: "orphan" });

    expect(await repo.count({ parentId: null })).toBe(before + 1);
    expect(await repo.exists({ parentId: null })).toBe(true);
    expect(await repo.exists({ parentId: 7 })).toBe(true);

    await repo.delete(orphan.id);
    expect(await repo.count({ parentId: null })).toBe(before);
  });

  it("encrypts on both create and update, and decrypts on read", async () => {
    const repo = db.getRepository(Secret);
    const created: any = await repo.create({ name: "a", ssn: "111-11-1111" });

    const rawAfterCreate = await db.client.query(
      "SELECT ssn FROM secrets WHERE id = ?",
      [created.id],
    );
    expect(rawAfterCreate[0].ssn).not.toBe("111-11-1111");
    expect(decrypt(rawAfterCreate[0].ssn)).toBe("111-11-1111");
    expect(created.ssn).toBe("111-11-1111");

    await repo.update(created.id, { ssn: "222-22-2222" });

    const rawAfterUpdate = await db.client.query(
      "SELECT ssn FROM secrets WHERE id = ?",
      [created.id],
    );
    // An update must not write plaintext into an encrypted column.
    expect(rawAfterUpdate[0].ssn).not.toBe("222-22-2222");
    expect(decrypt(rawAfterUpdate[0].ssn)).toBe("222-22-2222");

    expect((await repo.findOne(created.id))?.ssn).toBe("222-22-2222");
  });

  it("creates the version history table with a version column", async () => {
    const cols = await db.client.query("PRAGMA table_info(accounts_history)");
    expect(cols.map((c: any) => c.name)).toContain("version");
  });

  it("writes history rows for a versioned model", async () => {
    const repo = db.getRepository(Account);
    const created: any = await repo.create({ name: "acct" });

    const history = await repo.history(created.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].operation).toBe("insert");
  });
});
