import { describe, it, expect } from "vitest";
import { StabilizeKV, globToRegExp } from "../stabilize-kv";
import { Cache } from "../cache";
import { Stabilize } from "../index";
import { DBType } from "../types";

/**
 * The in-process cache.
 *
 * `CacheConfig.enabled: true` with no `redisUrl` used to build no client at
 * all, and every method returned on its first line: `get` answered `null`,
 * `set` discarded its value, `getStats` reported zeros forever, and nothing was
 * logged. The configuration said caching was on and nothing contradicted it.
 * These cover the store that replaced that hole, and then the `Cache` built on
 * it.
 */

/** A clock that only moves when a test moves it. */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

describe("StabilizeKV", () => {
  it("round-trips text and JSON", async () => {
    const kv = new StabilizeKV();

    await kv.put("greeting", "hello");
    await kv.put("user", { name: "Ada", roles: ["admin"] });

    expect(await kv.get("greeting")).toBe("hello");
    expect(await kv.get("user", { type: "json" })).toEqual({
      name: "Ada",
      roles: ["admin"],
    });
  });

  it("refuses to parse a bare string as JSON, as Workers KV does", async () => {
    const kv = new StabilizeKV();
    await kv.put("greeting", "hello");

    // Workers KV stores bytes, so `type: "json"` on a value that is not JSON
    // is an error rather than a silent fallback to the raw text.
    await expect(kv.get("greeting", { type: "json" })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("treats a null value as a delete", async () => {
    const kv = new StabilizeKV();
    await kv.put("k", "v");
    await kv.put("k", null);

    expect(await kv.get("k")).toBeNull();
  });

  it("expires on expirationTtl, measured from now", async () => {
    const clock = fakeClock();
    const kv = new StabilizeKV({ now: clock.now });

    await kv.put("k", "v", { expirationTtl: 60 });
    expect(await kv.get("k")).toBe("v");

    clock.advance(59);
    expect(await kv.get("k")).toBe("v");

    clock.advance(2);
    expect(await kv.get("k")).toBeNull();
  });

  it("expires on an absolute expiration in seconds, not milliseconds", async () => {
    const clock = fakeClock();
    const kv = new StabilizeKV({ now: clock.now });
    const at = Math.floor(clock.now() / 1000) + 30;

    await kv.put("k", "v", { expiration: at });

    clock.advance(29);
    expect(await kv.get("k")).toBe("v");
    clock.advance(2);
    expect(await kv.get("k")).toBeNull();
  });

  it("refuses both expirations at once, and refuses a non-positive one", async () => {
    const kv = new StabilizeKV();

    await expect(
      kv.put("k", "v", { expiration: 1, expirationTtl: 60 }),
    ).rejects.toThrow(/not both/);
    await expect(kv.put("k", "v", { expirationTtl: 0 })).rejects.toThrow(
      /must be positive/,
    );
  });

  it("keeps metadata beside the value and returns it separately", async () => {
    const kv = new StabilizeKV();
    await kv.put("k", { a: 1 }, { metadata: { source: "test" } });

    const { value, metadata } = await kv.getWithMetadata("k", {
      type: "json",
    });

    expect(value).toEqual({ a: 1 });
    expect(metadata).toEqual({ source: "test" });
  });

  it("reports a missing key as a null value and null metadata", async () => {
    const kv = new StabilizeKV();
    expect(await kv.getWithMetadata("absent")).toEqual({
      value: null,
      metadata: null,
    });
  });

  it("lists keys lexicographically and pages with a cursor", async () => {
    const kv = new StabilizeKV();
    for (const name of ["c", "a", "e", "b", "d"]) {
      await kv.put(name, name);
    }

    const first = await kv.list({ limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual(["a", "b"]);
    expect(first.list_complete).toBe(false);
    expect(first.cursor).toBeDefined();

    const second = await kv.list({ limit: 2, cursor: first.cursor });
    expect(second.keys.map((k) => k.name)).toEqual(["c", "d"]);
    expect(second.list_complete).toBe(false);

    const third = await kv.list({ limit: 2, cursor: second.cursor });
    expect(third.keys.map((k) => k.name)).toEqual(["e"]);
    expect(third.list_complete).toBe(true);
    expect(third.cursor).toBeUndefined();
  });

  it("filters a listing by prefix and reports expiry in seconds", async () => {
    const clock = fakeClock();
    const kv = new StabilizeKV({ now: clock.now });
    const at = Math.floor(clock.now() / 1000) + 120;

    await kv.put("user:1", "a");
    await kv.put("user:2", "b", { expiration: at });
    await kv.put("post:1", "c");

    const page = await kv.list({ prefix: "user:" });

    expect(page.keys.map((k) => k.name)).toEqual(["user:1", "user:2"]);
    expect(page.keys[0]!.expiration).toBeNull();
    expect(page.keys[1]!.expiration).toBe(at);
    expect(page.list_complete).toBe(true);
  });

  it("leaves an expired key out of a listing", async () => {
    const clock = fakeClock();
    const kv = new StabilizeKV({ now: clock.now });
    await kv.put("gone", "v", { expirationTtl: 1 });
    await kv.put("stays", "v");

    clock.advance(5);

    expect((await kv.list()).keys.map((k) => k.name)).toEqual(["stays"]);
    expect(await kv.keys()).toEqual(["stays"]);
  });

  it("refuses a cursor it did not issue", async () => {
    const kv = new StabilizeKV();
    await expect(kv.list({ cursor: "not-a-cursor" })).rejects.toThrow(
      /Invalid cursor/,
    );
  });

  it("evicts the least recently used entry once it is full", async () => {
    const kv = new StabilizeKV({ maxEntries: 3 });

    await kv.put("a", "1");
    await kv.put("b", "2");
    await kv.put("c", "3");

    // `a` is read, so it is no longer the least recently used when `d` arrives.
    expect(await kv.get("a")).toBe("1");
    await kv.put("d", "4");

    expect(await kv.get("a")).toBe("1");
    expect(await kv.get("b")).toBeNull();
    expect(await kv.get("c")).toBe("3");
    expect(await kv.get("d")).toBe("4");
  });

  it("refuses a maxEntries that is not a positive integer", () => {
    expect(() => new StabilizeKV({ maxEntries: 0 })).toThrow(/positive integer/);
    expect(() => new StabilizeKV({ maxEntries: 2.5 })).toThrow(/positive integer/);
  });

  it("matches a glob across its whole form", async () => {
    const kv = new StabilizeKV();
    for (const name of ["user:1", "user:2", "user:ab", "post:1"]) {
      await kv.put(name, name);
    }

    expect(await kv.keys("user:*")).toEqual(["user:1", "user:2", "user:ab"]);
    expect(await kv.keys("user:?")).toEqual(["user:1", "user:2"]);
    expect(await kv.keys("user:[0-9]")).toEqual(["user:1", "user:2"]);
    expect(await kv.keys("user:[^0-9]*")).toEqual(["user:ab"]);
    expect(await kv.keys("post:1")).toEqual(["post:1"]);
    expect(await kv.keys("*:1")).toEqual(["post:1", "user:1"]);
  });

  it("deletes by pattern and reports how many went", async () => {
    const kv = new StabilizeKV();
    await kv.put("user:1", "a");
    await kv.put("user:2", "b");
    await kv.put("post:1", "c");

    expect(await kv.deletePattern("user:*")).toBe(2);
    expect(await kv.keys()).toEqual(["post:1"]);
  });

  it("clears everything on request", async () => {
    const kv = new StabilizeKV();
    await kv.put("a", "1");
    await kv.put("b", "2");

    kv.clear();

    expect(kv.size).toBe(0);
    expect(await kv.get("a")).toBeNull();
  });
});

describe("globToRegExp", () => {
  it("anchors the whole name, so a partial match is not one", () => {
    expect(globToRegExp("user").test("user")).toBe(true);
    expect(globToRegExp("user").test("user:1")).toBe(false);
    expect(globToRegExp("user").test("superuser")).toBe(false);
  });

  it("treats a regex metacharacter as a literal", () => {
    // The pattern is a glob, not a regular expression: `a.b` must not match
    // `axb`, and `a+b` must not be "one or more a".
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a+b").test("aab")).toBe(false);
    expect(globToRegExp("a(b)").test("ab")).toBe(false);
  });

  it("closes a character class that holds a bracket", () => {
    // `[]]` is a class containing `]` and nothing else. A scan that stopped at
    // the first `]` would call the class empty, and JavaScript reads an empty
    // class as matching nothing — so the pattern would silently match no key
    // at all rather than the wrong ones.
    expect(globToRegExp("a[]]").test("a]")).toBe(true);
    expect(globToRegExp("a[]]").test("a[")).toBe(false);
    expect(globToRegExp("a[]]").test("a")).toBe(false);
  });

  it("reads `!` in a class as a literal, not as negation", () => {
    // Redis negates with `^` only. Reading `!` as negation too would turn a
    // class of four literals into one that matches everything but them.
    expect(globToRegExp("a[!b]").test("a!")).toBe(true);
    expect(globToRegExp("a[!b]").test("ab")).toBe(true);
    expect(globToRegExp("a[!b]").test("ac")).toBe(false);
  });

  it("treats an unterminated class as a literal bracket, as Redis does", () => {
    expect(globToRegExp("a[").test("a[")).toBe(true);
    expect(globToRegExp("a[").test("ab")).toBe(false);
  });

  it("lets a backslash escape the next character", () => {
    expect(globToRegExp("a\\*b").test("a*b")).toBe(true);
    expect(globToRegExp("a\\*b").test("axxb")).toBe(false);
  });
});

describe("Cache with no redisUrl", () => {
  /** The configuration the bug report was about. */
  const memoryOnly = { enabled: true, ttl: 60 } as const;

  it("reports the backend it actually built", () => {
    expect(new Cache({ ...memoryOnly }).backend).toBe("memory");
    expect(new Cache({ enabled: false, ttl: 60 }).backend).toBe("disabled");
  });

  it("reports the backend through getStats, and in the ORM's own stats", async () => {
    const disabled = new Cache({ enabled: false, ttl: 60 });
    expect(await disabled.getStats()).toEqual({
      hits: 0,
      misses: 0,
      keys: 0,
      backend: "disabled",
    });

    const orm = new Stabilize(
      { type: DBType.SQLite, connectionString: ":memory:" },
      { ...memoryOnly },
    );
    try {
      expect((await orm.getCacheStats()).backend).toBe("memory");
    } finally {
      await orm.close();
    }
  });

  it("names the backend in the health check rather than claiming a connection", async () => {
    // An in-process cache has no connection to report, so `"connected"` was a
    // claim rather than an answer.
    const orm = new Stabilize(
      { type: DBType.SQLite, connectionString: ":memory:" },
      { ...memoryOnly },
    );
    try {
      expect((await orm.healthCheck()).cacheStatus).toBe("in-memory");
    } finally {
      await orm.close();
    }

    const uncached = new Stabilize({
      type: DBType.SQLite,
      connectionString: ":memory:",
    });
    try {
      expect((await uncached.healthCheck()).cacheStatus).toBe("disabled");
    } finally {
      await uncached.close();
    }
  });

  it("stores and returns a value instead of discarding it", async () => {
    const cache = new Cache({ ...memoryOnly });

    await cache.set("user:1", { name: "Ada" });

    expect(await cache.get("user:1")).toEqual({ name: "Ada" });
  });

  it("counts hits and misses, which used to stay at zero", async () => {
    const cache = new Cache({ ...memoryOnly });

    expect(await cache.get("absent")).toBeNull();
    await cache.set("present", 1);
    await cache.get("present");

    // `backend` travels with the counters so a cache that is doing nothing is
    // distinguishable from one that is merely cold.
    expect(await cache.getStats()).toEqual({
      hits: 1,
      misses: 1,
      keys: 1,
      backend: "memory",
    });
  });

  it("expires an entry after the configured ttl", async () => {
    const cache = new Cache({ enabled: true, ttl: 1 });
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v");

    // The memory store takes its clock from `Date.now` and the Cache does not
    // expose a way to inject one, so this waits. One second is short enough.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(await cache.get("k")).toBeNull();
  });

  it("honours a per-call ttl over the configured one", async () => {
    const cache = new Cache({ enabled: true, ttl: 3600 });
    await cache.set("brief", "v", 1);
    await cache.set("long", "v");

    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(await cache.get("brief")).toBeNull();
    expect(await cache.get("long")).toBe("v");
  });

  it("invalidates exact keys", async () => {
    const cache = new Cache({ ...memoryOnly });
    await cache.set("user:1", "a");
    await cache.set("user:2", "b");

    await cache.invalidate(["user:1"]);

    expect(await cache.get("user:1")).toBeNull();
    expect(await cache.get("user:2")).toBe("b");
  });

  it("invalidates by pattern, including through the cache prefix", async () => {
    const cache = new Cache({ ...memoryOnly, cachePrefix: "app:" });
    await cache.set("user:1", "a");
    await cache.set("user:2", "b");
    await cache.set("post:1", "c");

    await cache.invalidatePattern("user:*");

    expect(await cache.get("user:1")).toBeNull();
    expect(await cache.get("user:2")).toBeNull();
    expect(await cache.get("post:1")).toBe("c");
    // The prefix has to travel with the pattern, or the scan matches nothing
    // and invalidation silently does nothing — the failure this whole file is
    // about, one layer down.
    expect((await cache.getStats()).keys).toBe(1);
  });

  it("counts only its own keys when a prefix is set", async () => {
    const cache = new Cache({ ...memoryOnly, cachePrefix: "app:" });
    await cache.set("a", 1);
    await cache.set("b", 2);

    expect((await cache.getStats()).keys).toBe(2);
  });

  it("passes maxEntries through to the in-process store", async () => {
    const cache = new Cache({ ...memoryOnly, maxEntries: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);

    expect((await cache.getStats()).keys).toBe(2);
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("c")).toBe(3);
  });

  it("treats an unreadable value as a miss rather than throwing", async () => {
    // A key can hold something this cache did not write — another application
    // sharing the prefix, or a value left by a previous version of the model.
    // The reach into `store.kv` is deliberate: nothing in `Cache`'s API can put
    // a non-JSON value under one of its own keys, which is exactly why the read
    // path has to survive finding one.
    const cache = new Cache({ ...memoryOnly });
    await cache.set("k", "v");
    await (cache as any).store.kv.put("k", "not json at all");

    expect(await cache.get("k")).toBeNull();
    expect((await cache.getStats()).misses).toBe(1);
  });

  it("drops everything on disconnect", async () => {
    const cache = new Cache({ ...memoryOnly });
    await cache.set("k", "v");

    await cache.disconnect();

    expect(await cache.get("k")).toBeNull();
  });

  it("keeps the strategy it was configured with", () => {
    expect(new Cache({ ...memoryOnly }).getStrategy()).toBe("cache-aside");
    expect(
      new Cache({ ...memoryOnly, strategy: "write-through" }).getStrategy(),
    ).toBe("write-through");
  });
});
