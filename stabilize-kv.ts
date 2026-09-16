/**
 * @file stabilize-kv.ts
 * @description StabilizeKV — an in-process key-value store.
 * @author ElectronSz
 *
 * Exists because `Cache` had no fallback. A `CacheConfig` with `enabled: true`
 * and no `redisUrl` built no client at all, and every method returned early:
 * `get` answered `null`, `set` discarded its value, `getStats` reported zeros
 * forever, and nothing was logged. The failure mode was not "caching is off" —
 * it was "caching is on", reported as healthy, and doing nothing.
 *
 * The API follows Cloudflare Workers KV deliberately: `get`/`put`/`delete`/`list`
 * with `expiration` and `expirationTtl` in seconds, an opaque `cursor` for
 * pagination, arbitrary `metadata` alongside a value, and `list_complete`
 * rather than a count. The shape is familiar, a test double for Workers KV
 * needs no adapter, and code written against it ports to the real thing.
 *
 * What it is not: durable, shared, or replicated. It lives in one process, dies
 * with it, and is invisible to every other instance of the application. That is
 * the trade being made for having no server to run — and it is stated here
 * rather than left for someone to discover in production.
 */

import { StabilizeError } from "./types";

/** Anything JSON can carry, which is what a KV value is here. */
export type StabilizeKVValue = string | number | boolean | object | null;

/** Arbitrary caller-supplied data stored beside a value. */
export type StabilizeKVMetadata = Record<string, unknown>;

/**
 * Reads options.
 *
 * `cacheTtl` is accepted and ignored. Cloudflare applies it as a *minimum*
 * cache lifetime at the edge, on top of the stored expiration; there is no edge
 * here, so there is nothing for it to do. Accepted rather than omitted so code
 * written against Workers KV compiles unchanged.
 */
export interface StabilizeKVGetOptions {
  type?: "text" | "json";
  cacheTtl?: number;
}

/** Write options. At most one of the two expirations may be given. */
export interface StabilizeKVPutOptions {
  /** Absolute expiry, in **seconds** since the epoch — Cloudflare's unit. */
  expiration?: number;
  /** Relative expiry, in **seconds** from now. */
  expirationTtl?: number;
  metadata?: StabilizeKVMetadata;
}

/** One entry as `list` reports it. The value itself is not included. */
export interface StabilizeKVKey {
  name: string;
  /** Absolute expiry in seconds since the epoch, or `null` if it never expires. */
  expiration: number | null;
  metadata: StabilizeKVMetadata | null;
}

/** A page of keys. `list_complete` is false when `cursor` is present. */
export interface StabilizeKVListResult {
  keys: StabilizeKVKey[];
  list_complete: boolean;
  cursor?: string;
}

/** Paging options for {@link StabilizeKV.list}. */
export interface StabilizeKVListOptions {
  /** Only keys starting with this are returned. */
  prefix?: string;
  /** Maximum keys per page. Defaults to 1000, as Workers KV does. */
  limit?: number;
  /** A `cursor` from a previous page. */
  cursor?: string;
}

/** Construction options. */
export interface StabilizeKVOptions {
  /**
   * How many live entries to hold before the least recently used is evicted.
   *
   * A `Map` in a long-lived process is a leak unless something bounds it, and
   * an unbounded cache that quietly grows until the process dies is the same
   * class of defect as the silent no-op this file exists to fix. Defaults to
   * 1000.
   */
  maxEntries?: number;
  /**
   * A clock, in milliseconds, so expiry can be asserted without waiting for it.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

/** How long a `set` should live, in milliseconds, or `null` for forever. */
type Lifetime = number | null;

interface StabilizeKVEntry {
  text: string;
  /** Absolute expiry in **milliseconds**, or `null`. */
  expiresAt: number | null;
  metadata: StabilizeKVMetadata | null;
}

/** The prefix a cursor carries, so a cursor from another store is refused. */
const CURSOR_PREFIX = "memkv:";

/**
 * Translates a Redis-style glob into a regular expression.
 *
 * `invalidatePattern` documents glob patterns — `user:*` — and Redis's `KEYS`
 * implements the full form, so the in-process backend has to match it rather
 * than approximate it with a prefix test. Supported: `*`, `?`, `[abc]`,
 * `[a-z]`, `[^abc]`, and `\` escaping the next character.
 *
 * Exported so the translation can be asserted directly, which is the only
 * practical way to test the character-class cases.
 *
 * One divergence from JavaScript, which the caller never sees: a class holding
 * a `]` is written `[]]` here and `[\]]` in the regex, because JavaScript
 * reads `[]]` as an empty class followed by a literal.
 *
 * @param pattern The glob pattern.
 * @returns An anchored, case-sensitive regular expression.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    // `charAt` rather than `[i]`: the latter widens to `string | undefined`
    // under `noUncheckedIndexedAccess`, and every branch below is a comparison
    // that the undefined case would have to be excluded from by hand.
    const char = pattern.charAt(i);
    const next = pattern.charAt(i + 1);
    if (char === "\\" && i + 1 < pattern.length) {
      out += escapeRegExp(next);
      i++;
      continue;
    }
    if (char === "*") {
      out += ".*";
      continue;
    }
    if (char === "?") {
      out += ".";
      continue;
    }
    if (char === "[") {
      // Scan to the closing bracket, so a `]` inside the class — legal, and
      // what `[]]` means — does not end it early. An unterminated class is
      // treated as a literal `[`, matching Redis.
      let end = i + 1;
      if (pattern.charAt(end) === "^") end++;
      if (pattern.charAt(end) === "]") end++;
      while (end < pattern.length && pattern.charAt(end) !== "]") end++;

      if (end >= pattern.length) {
        out += "\\[";
        continue;
      }

      const body = pattern.slice(i + 1, end);
      // Only `^` negates. Redis's glob does not treat a leading `!` as
      // negation, and neither does this — a `[!abc]` here is a class of four
      // literals, which is what it is in Redis.
      const negated = body.startsWith("^");
      const inner = negated ? body.slice(1) : body;
      out += `[${negated ? "^" : ""}${escapeClass(inner)}]`;
      i = end;
      continue;
    }
    out += escapeRegExp(char);
  }
  return new RegExp(`^${out}$`);
}

/** Escapes the characters that are special in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escapes a character-class body.
 *
 * Only `\` and `]` need it. `-` must be left alone or every range — `[a-z]` —
 * would stop being one, and `.` `*` `+` `(` are literal inside a class in
 * JavaScript, so escaping them would introduce a backslash the class then
 * matches.
 *
 * `]` is not optional: unlike POSIX, JavaScript reads `[]]` as an *empty*
 * class followed by a literal `]`, and an empty class matches nothing at all.
 */
function escapeClass(body: string): string {
  return body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

/**
 * An in-process key-value store with Cloudflare Workers KV's API.
 *
 * @example
 * ```
 * const kv = new StabilizeKV();
 * await kv.put("user:1", { name: "Ada" }, { expirationTtl: 60 });
 * const user = await kv.get<{ name: string }>("user:1", { type: "json" });
 * ```
 */
export class StabilizeKV {
  private store = new Map<string, StabilizeKVEntry>();
  private maxEntries: number;
  private clock: () => number;

  constructor(options: StabilizeKVOptions = {}) {
    const max = options.maxEntries;
    if (max !== undefined && (!Number.isInteger(max) || max <= 0)) {
      throw new StabilizeError(
        `maxEntries must be a positive integer, received ${max}.`,
        "VALIDATION_ERROR",
      );
    }
    this.maxEntries = max ?? 1000;
    this.clock = options.now ?? Date.now;
  }

  /** How many entries are held, expired ones included. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Reads a value.
   *
   * @param key The key to read.
   * @param options `type: "json"` parses the stored text, as Workers KV does;
   *   the default, `"text"`, returns it as written.
   * @returns The value, or `null` if absent or expired.
   */
  async get<T = string>(
    key: string,
    options: StabilizeKVGetOptions = {},
  ): Promise<T | null> {
    const entry = this.live(key);
    if (!entry) return null;

    // A read is a use, so the entry moves to the end of the insertion order —
    // which is what makes `maxEntries` evict the least recently *used* rather
    // than the least recently written.
    this.store.delete(key);
    this.store.set(key, entry);

    if (options.type === "json") {
      try {
        return JSON.parse(entry.text) as T;
      } catch (error) {
        throw new StabilizeError(
          `Value at key '${key}' is not valid JSON.`,
          "CACHE_ERROR",
          error as Error,
        );
      }
    }
    return entry.text as T;
  }

  /**
   * Reads a value together with the metadata stored beside it.
   *
   * @param key The key to read.
   * @param options As {@link get}.
   * @returns The value and metadata; both are `null` when the key is absent.
   */
  async getWithMetadata<T = string>(
    key: string,
    options: StabilizeKVGetOptions = {},
  ): Promise<{ value: T | null; metadata: StabilizeKVMetadata | null }> {
    const entry = this.live(key);
    if (!entry) return { value: null, metadata: null };
    return { value: await this.get<T>(key, options), metadata: entry.metadata };
  }

  /**
   * Writes a value.
   *
   * A string is stored as written. Anything else is JSON-encoded, which is what
   * makes `get(key, { type: "json" })` symmetric for objects — and what makes a
   * bare string readable with `type: "text"` but not with `type: "json"`,
   * exactly as Workers KV behaves.
   *
   * @param key The key to write.
   * @param value The value. `null` deletes the key, matching Workers KV.
   * @param options Expiry and metadata.
   */
  async put(
    key: string,
    value: StabilizeKVValue,
    options: StabilizeKVPutOptions = {},
  ): Promise<void> {
    if (value === null) {
      this.store.delete(key);
      return;
    }
    const expiresAt = this.resolveExpiry(options);
    const text = typeof value === "string" ? value : JSON.stringify(value);

    this.store.delete(key);
    this.store.set(key, {
      text,
      expiresAt,
      metadata: options.metadata ?? null,
    });

    this.evict();
  }

  /**
   * Removes a key.
   *
   * @param key The key to remove. Removing an absent key is not an error.
   */
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * Lists keys, in lexicographic order, one page at a time.
   *
   * @param options Prefix, page size and cursor.
   * @returns A page, and whether more follow.
   */
  async list(options: StabilizeKVListOptions = {}): Promise<StabilizeKVListResult> {
    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 1000;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new StabilizeError(
        `limit must be a positive integer, received ${limit}.`,
        "VALIDATION_ERROR",
      );
    }

    const after = options.cursor ? this.decodeCursor(options.cursor) : null;

    // Sorted rather than left in insertion order: Workers KV lists
    // lexicographically, and a caller paging through with a cursor relies on
    // the ordering being stable across calls, which insertion order is not
    // once a key is rewritten.
    const names = [...this.store.keys()]
      .filter((name) => this.live(name) !== null)
      .filter((name) => name.startsWith(prefix))
      .filter((name) => after === null || name > after)
      .sort();

    const page = names.slice(0, limit);
    const complete = page.length === names.length;
    const last = page.length > 0 ? page[page.length - 1]! : "";

    return {
      keys: page.map((name) => {
        const entry = this.store.get(name)!;
        return {
          name,
          expiration:
            entry.expiresAt === null ? null : Math.floor(entry.expiresAt / 1000),
          metadata: entry.metadata,
        };
      }),
      list_complete: complete,
      ...(complete ? {} : { cursor: this.encodeCursor(last) }),
    };
  }

  /**
   * Removes every key matching a Redis-style glob.
   *
   * Not part of the Workers KV API — Cloudflare has no pattern delete, because
   * a scan there is expensive. Here it is a linear pass over one process's own
   * memory, which is what `Cache.invalidatePattern` has always promised.
   *
   * @param pattern The glob, e.g. `user:*`.
   * @returns The number of keys removed.
   */
  async deletePattern(pattern: string): Promise<number> {
    const match = globToRegExp(pattern);
    let removed = 0;
    for (const name of [...this.store.keys()]) {
      if (match.test(name)) {
        this.store.delete(name);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Names of every live key matching a glob.
   *
   * @param pattern The glob, e.g. `user:*`.
   */
  async keys(pattern = "*"): Promise<string[]> {
    const match = globToRegExp(pattern);
    return [...this.store.keys()]
      .filter((name) => this.live(name) !== null)
      .filter((name) => match.test(name))
      .sort();
  }

  /** Drops every entry, live or expired. */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the entry at `key` if it is present and unexpired, removing it if it
   * is present and expired.
   */
  private live(key: string): StabilizeKVEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  /** Turns the two expiry options into one absolute deadline in milliseconds. */
  private resolveExpiry(options: StabilizeKVPutOptions): number | null {
    if (options.expiration !== undefined && options.expirationTtl !== undefined) {
      throw new StabilizeError(
        "Provide either expiration or expirationTtl, not both.",
        "VALIDATION_ERROR",
      );
    }
    if (options.expirationTtl !== undefined) {
      if (options.expirationTtl <= 0) {
        throw new StabilizeError(
          `expirationTtl must be positive, received ${options.expirationTtl}.`,
          "VALIDATION_ERROR",
        );
      }
      return this.clock() + options.expirationTtl * 1000;
    }
    if (options.expiration !== undefined) {
      return options.expiration * 1000;
    }
    return null;
  }

  /**
   * Drops the least recently used entries until the store fits.
   *
   * Iteration order is insertion order, and `get` re-inserts what it reads, so
   * the first key is the one that has gone longest without being touched.
   */
  private evict(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) return;
      this.store.delete(oldest.value);
    }
  }

  /** Marks a key name as a cursor from this store, so a foreign one is refused. */
  private encodeCursor(name: string): string {
    return CURSOR_PREFIX + Buffer.from(name, "utf8").toString("base64url");
  }

  /** Reads a cursor back, refusing anything this store did not issue. */
  private decodeCursor(cursor: string): string {
    if (!cursor.startsWith(CURSOR_PREFIX)) {
      throw new StabilizeError(
        `Invalid cursor. Expected one returned by list().`,
        "VALIDATION_ERROR",
      );
    }
    return Buffer.from(
      cursor.slice(CURSOR_PREFIX.length),
      "base64url",
    ).toString("utf8");
  }
}
