import { describe, it, expect, beforeEach } from "vitest";
import { Repository } from "../repository";
import { defineModel } from "../model";
import { DataTypes, DBType } from "../types";

/**
 * The cache is write-through for single rows, so the key a read looks up must
 * be the key a write stores and the key a write invalidates.
 *
 * These tests pin that agreement. The read key used to carry a
 * `:${relations.join(",")}` suffix, which rendered as the literal string
 * `undefined` for the common no-relations call — so every write-through `set`
 * and every `invalidate` addressed a key that no read ever consulted, and a
 * stale row was served until its TTL expired.
 */

const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING },
    deleted_at: { type: DataTypes.DATETIME, softDelete: true },
  },
});

/** Records every cache interaction and serves back whatever was stored. */
class RecordingCache {
  public gets: string[] = [];
  public sets: { key: string; value: any }[] = [];
  public invalidated: string[] = [];
  public patterns: string[] = [];
  private store = new Map<string, any>();
  public config = { enabled: true, ttl: 60, strategy: "write-through" as const };

  getStrategy() {
    return this.config.strategy;
  }

  async get<T>(key: string): Promise<T | null> {
    this.gets.push(key);
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.sets.push({ key, value });
    this.store.set(key, value);
  }

  async invalidate(keys: string[]): Promise<void> {
    this.invalidated.push(...keys);
    for (const key of keys) this.store.delete(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    this.patterns.push(pattern);
    const prefix = pattern.replace(/\*$/, "");
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

/** Minimal client: `findOne` only needs `query` to answer the SELECT. */
function makeClient(rows: any[] = []) {
  return {
    config: { type: DBType.SQLite },
    queries: [] as string[],
    async query(sql: string) {
      this.queries.push(sql);
      return rows;
    },
    async queryExec() {
      return { affectedRows: 1 };
    },
    async transaction<T>(fn: (c: any) => Promise<T>): Promise<T> {
      return fn(this);
    },
  } as any;
}

describe("repository cache keys", () => {
  let cache: RecordingCache;
  let repo: any;

  beforeEach(() => {
    cache = new RecordingCache();
    repo = new Repository(makeClient([{ id: 5, name: "Ada" }]), User);
    repo.cache = cache;
  });

  it("reads and write-through-stores the same key when no relations are loaded", async () => {
    await repo.findOne(5);
    await repo.writeThroughRow(5, { id: 5, name: "Ada" });

    const readKey = cache.gets[0];
    const writtenKey = cache.sets[0].key;

    expect(readKey).toBe("findOne:users:5");
    expect(writtenKey).toBe(readKey);
    // The bug: a literal "undefined" segment made the two disagree.
    expect(readKey).not.toContain("undefined");
  });

  it("serves a write-through row back to the next read", async () => {
    await repo.writeThroughRow(5, { id: 5, name: "Ada" });

    const found = await repo.findOne(5);

    expect(found).toEqual({ id: 5, name: "Ada" });
  });

  it("invalidates the key that reads use", async () => {
    await repo.writeThroughRow(5, { id: 5, name: "Ada" });
    await repo.invalidateRowCache(5);

    expect(cache.invalidated).toContain("findOne:users:5");
    expect(await repo.findOne(5)).toEqual({ id: 5, name: "Ada" });
    // Re-read after invalidation must be a miss, then fall through to the DB.
    expect(cache.gets).toContain("findOne:users:5");
  });

  it("keys relation-loaded reads apart, but deterministically", async () => {
    const plain = repo.rowCacheKey(5);
    const withPosts = repo.rowCacheKey(5, ["posts"]);
    const withTags = repo.rowCacheKey(5, ["tags"]);

    expect(plain).toBe("findOne:users:5");
    expect(withPosts).toBe("findOne:users:5:posts");
    expect(withTags).toBe("findOne:users:5:tags");

    // Relation order must not produce two entries for the same result shape.
    expect(repo.rowCacheKey(5, ["tags", "posts"])).toBe(
      repo.rowCacheKey(5, ["posts", "tags"]),
    );
    expect(repo.rowCacheKey(5, [])).toBe(plain);
  });

  it("clears relation-loaded variants when a row is invalidated", async () => {
    await cache.set(repo.rowCacheKey(5, ["posts"]), [{ id: 5 }]);
    await repo.invalidateRowCache(5);

    expect(
      cache.patterns.some((p: string) => p.startsWith("findOne:users:5")),
    ).toBe(true);
    expect(await cache.get(repo.rowCacheKey(5, ["posts"]))).toBeNull();
  });

  it("clears per-row entries on a multi-row write", async () => {
    await cache.set(repo.rowCacheKey(5), [{ id: 5 }]);
    await repo.invalidateTableCache();

    expect(await cache.get(repo.rowCacheKey(5))).toBeNull();
  });

  it("does not cache a read taken inside a transaction", async () => {
    const txClient = makeClient([{ id: 5, name: "Ada" }]);
    txClient.isTransactionClient = true;

    await repo.findOne(5, {}, txClient);

    expect(cache.gets).toEqual([]);
    expect(cache.sets).toEqual([]);
  });
});
