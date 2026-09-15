import { describe, it, expect, beforeEach } from "vitest";
import { Repository } from "../repository";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * Writes issued through a repository must run on the client they were given.
 *
 * `stabilize.transaction(cb)` hands the callback a *separate* client bound to
 * one pooled connection. On PostgreSQL and MySQL the repository used to reach
 * for its own root client instead, so a write inside a transaction ran on a
 * different connection and survived the rollback.
 */

const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING },
    logins: { type: DataTypes.INTEGER },
    deleted_at: { type: DataTypes.DATETIME, softDelete: true },
  },
});

/** A client that records every statement it is asked to run. */
function makeClient(rows: any[] = []) {
  return {
    config: { type: DBType.Postgres },
    isTransactionClient: false,
    statements: [] as string[],
    execs: [] as string[],
    async query(sql: string) {
      this.statements.push(sql);
      return rows;
    },
    async queryExec(sql: string) {
      this.execs.push(sql);
      return { affectedRows: 1 };
    },
    async transaction<T>(fn: (c: any) => Promise<T>): Promise<T> {
      return fn(this);
    },
  } as any;
}

describe("repository write routing", () => {
  let root: any;
  let tx: any;
  let repo: any;

  beforeEach(() => {
    root = makeClient([{ id: 1, name: "Ada" }]);
    tx = makeClient([{ id: 1, name: "Ada" }]);
    tx.isTransactionClient = true;
    repo = new Repository(root, User);
    repo.cache = null;
  });

  it("creates on the supplied transaction client, not the root client", async () => {
    await repo.create({ id: 1, name: "Ada" }, {}, tx);

    expect(tx.statements.length).toBeGreaterThan(0);
    expect(root.statements).toEqual([]);
    expect(root.execs).toEqual([]);
  });

  it("updates on the supplied transaction client", async () => {
    await repo.update(1, { name: "Ada L" }, tx);

    expect(tx.statements.length).toBeGreaterThan(0);
    expect(root.statements).toEqual([]);
  });

  it("deletes on the supplied transaction client", async () => {
    await repo.delete(1, tx);

    expect(tx.execs.length + tx.statements.length).toBeGreaterThan(0);
    expect(root.execs).toEqual([]);
    expect(root.statements).toEqual([]);
  });

  it("runs bulk and condition-based writes on the supplied client", async () => {
    await repo.updateBy({ name: "Ada" }, { name: "Ada L" }, tx);
    await repo.deleteBy({ name: "Ada" }, tx);
    await repo.restoreBy({ name: "Ada" }, tx);
    await repo.increment(1, "logins", 1, tx);
    await repo.decrement(1, "logins", 1, tx);
    await repo.toggle(1, "logins", tx);
    await repo.truncate(tx);

    expect(root.execs).toEqual([]);
    expect(root.statements).toEqual([]);
    expect(tx.execs.length).toBeGreaterThanOrEqual(7);
  });

  it("still uses its own client when none is supplied", async () => {
    await repo.updateBy({ name: "Ada" }, { name: "Ada L" });

    expect(root.execs.length).toBe(1);
    expect(tx.execs).toEqual([]);
  });
});
