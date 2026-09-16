import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Cache, Repository, Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType, RelationType } from "../types";

/**
 * End-to-end coverage for eager-loaded relations.
 *
 * Relations used to be "loaded" by joining the target table onto the parent
 * query, and nothing ever copied the joined columns onto the parent. So
 * `findOne(id, { relations: ["chapters"] })` resolved to a row with no
 * `chapters` key at all. The join also multiplied each parent once per related
 * row, which meant `LIMIT 1` truncated a to-many relation to a single row and
 * `COUNT(*)` counted children instead of parents.
 *
 * These tests are written against real SQLite because every one of those
 * symptoms is a property of the SQL that was generated.
 */

const Author = defineModel({
  tableName: "rel_authors",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING, required: true },
  },
});

const Tag = defineModel({
  tableName: "rel_tags",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING, required: true },
  },
  relations: [
    {
      type: RelationType.ManyToMany,
      target: () => Book,
      property: "books",
      joinTable: "rel_book_tags",
      foreignKey: "tag_id",
      inverseKey: "book_id",
    },
  ],
});

const Book = defineModel({
  tableName: "rel_books",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    // The property name deliberately differs from the column name: a relation
    // names the *property*, and the old join put that name straight into the
    // SQL, so a mapped key produced "no such column".
    authorId: { type: DataTypes.INTEGER, name: "author_id" },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Author,
      property: "author",
      foreignKey: "authorId",
    },
    {
      type: RelationType.OneToMany,
      target: () => Chapter,
      property: "chapters",
      inverseKey: "bookId",
    },
    {
      type: RelationType.ManyToMany,
      target: () => Tag,
      property: "tags",
      joinTable: "rel_book_tags",
      foreignKey: "book_id",
      inverseKey: "tag_id",
    },
  ],
});

const Chapter = defineModel({
  tableName: "rel_chapters",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING },
    bookId: { type: DataTypes.INTEGER, name: "book_id" },
    removedAt: { type: DataTypes.DATETIME, softDelete: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Book,
      property: "book",
      foreignKey: "bookId",
    },
  ],
});

describe("relation loading", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Author, Book, Chapter, Tag]);
    // Join tables have no model of their own, so `autoMigrate` does not create
    // them; a real application declares one in a migration.
    await db.rawExec(
      "CREATE TABLE rel_book_tags (book_id INTEGER, tag_id INTEGER)",
    );

    await db.rawExec("INSERT INTO rel_authors (id, name) VALUES (1, 'Ada')");
    // Book ids deliberately differ from their author's, so a row whose columns
    // were overwritten by the joined row is detectable.
    await db.rawExec(
      "INSERT INTO rel_books (id, title, author_id) VALUES (10, 'First', 1), (11, 'Second', 1), (12, 'Orphan', NULL)",
    );
    await db.rawExec(
      "INSERT INTO rel_chapters (id, title, book_id) VALUES (100, 'One', 10), (101, 'Two', 10), (102, 'Three', 10), (103, 'Other', 11)",
    );
    await db.rawExec(
      "INSERT INTO rel_tags (id, label) VALUES (1, 'alpha'), (2, 'beta')",
    );
    // Tag 2 is attached to book 10 first; the relation must preserve that order.
    await db.rawExec(
      "INSERT INTO rel_book_tags (book_id, tag_id) VALUES (10, 2), (10, 1), (11, 1)",
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it("attaches a to-many relation instead of dropping it", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["chapters"] });

    expect(book.chapters).toHaveLength(3);
    expect(book.chapters.map((c: any) => c.title)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });

  it("keeps the parent row intact when a relation is loaded", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["author"] });

    // The join used to leave the parent's own columns unprojected, so the
    // joined row's id could land in `book.id`.
    expect(book.id).toBe(10);
    expect(book.title).toBe("First");
    expect(book.author).toEqual({ id: 1, name: "Ada" });
  });

  it("resolves a foreign key declared under a mapped column name", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["author"] });

    // `authorId` is stored as `author_id`, so this only works at all if the
    // relation translates property names to column names — the old join put
    // `rel_books.authorId` into the SQL and failed with "no such column".
    expect(book.author.name).toBe("Ada");

    // Note: the base row's own key is the *column* name. Reads everywhere in
    // this library hand back driver rows, which are keyed by SQL column, so a
    // mapped column is not reachable under its property name. That is a
    // pre-existing wart across all read paths, not specific to relations.
    expect(book.author_id).toBe(1);
  });

  it("gives a to-one relation null when the key is unset", async () => {
    const orphan: any = await db
      .getRepository(Book)
      .findOne(12, { relations: ["author"] });

    // `null`, not `undefined`: the relation was loaded and is genuinely empty.
    expect(orphan.author).toBeNull();
  });

  it("counts parents, not joined children", async () => {
    const { data, total } = await db
      .getRepository(Book)
      .findAndCount({ relations: ["chapters"] });

    // Three chapters belong to one book; the join made COUNT(*) report them.
    expect(total).toBe(3);
    expect(data).toHaveLength(3);
    expect(data[0].chapters).toHaveLength(3);
  });

  it("returns the requested number of parents, not of children", async () => {
    const books = await db
      .getRepository(Book)
      .findMany({ relations: ["chapters"], take: 2 });

    // The join produced one row per chapter, so `take: 2` used to return the
    // same book twice rather than two books.
    expect(books).toHaveLength(2);
    expect(new Set(books.map((b: any) => b.id)).size).toBe(2);
  });

  it("loads a many-to-many relation through its join table", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["tags"] });

    // Order follows the join table, not the target table's own ordering.
    expect(book.tags.map((t: any) => t.label)).toEqual(["beta", "alpha"]);
  });

  it("returns an empty array for a relation with no links", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(12, { relations: ["tags"] });

    expect(book.tags).toEqual([]);
  });

  it("supports the inverse side of a many-to-many relation", async () => {
    const tag: any = await db
      .getRepository(Tag)
      .findOne(1, { relations: ["books"] });

    expect(tag.books.map((b: any) => b.title).sort()).toEqual([
      "First",
      "Second",
    ]);
  });

  it("loads a nested path against the target model", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["chapters.book"] });

    expect(book.chapters).toHaveLength(3);
    expect(book.chapters[0].book.title).toBe("First");
  });

  it("loads several relations in one call", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["author", "chapters", "tags"] });

    expect(book.author.id).toBe(1);
    expect(book.chapters).toHaveLength(3);
    expect(book.tags).toHaveLength(2);
  });

  it("gives every parent its own children in a batch read", async () => {
    const books = await db
      .getRepository(Book)
      .findMany({ relations: ["chapters"] });

    const byTitle = Object.fromEntries(
      books.map((b: any) => [b.title, b.chapters.map((c: any) => c.title)]),
    );

    // One batched query serves all parents, so the grouping has to be right.
    expect(byTitle["First"]).toEqual(["One", "Two", "Three"]);
    expect(byTitle["Second"]).toEqual(["Other"]);
    expect(byTitle["Orphan"]).toEqual([]);
  });

  it("omits related rows the target model soft-deleted", async () => {
    await db.rawExec(
      "UPDATE rel_chapters SET removedAt = '2020-01-01T00:00:00.000Z' WHERE id = 101",
    );
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["chapters"] });

    expect(book.chapters.map((c: any) => c.id)).toEqual([100, 102]);

    await db.rawExec("UPDATE rel_chapters SET removedAt = NULL WHERE id = 101");
  });

  it("loads relations for a findBy condition", async () => {
    const books = await db
      .getRepository(Book)
      .findBy({ authorId: 1 }, { relations: ["author"] });

    expect(books).toHaveLength(2);
    expect(books[0].author.name).toBe("Ada");
  });

  it("rejects an unknown relation name", async () => {
    // Silently returning the bare row is what made the bug so hard to notice.
    await expect(
      db.getRepository(Book).findOne(10, { relations: ["nope"] }),
    ).rejects.toThrow(/Relation nope not found/);
  });

  it("accepts foreignKey as the name of a OneToMany's inverse column", async () => {
    // Every example in the README and the docs site writes `foreignKey` for
    // the OneToMany side, so a model copied from the documentation has to work.
    const Shelf = defineModel({
      tableName: "rel_shelves",
      columns: {
        id: { type: DataTypes.INTEGER, required: true },
        name: { type: DataTypes.STRING },
      },
      relations: [
        {
          type: RelationType.OneToMany,
          target: () => Book,
          property: "books",
          foreignKey: "authorId",
        },
      ],
    });
    await db.autoMigrate([Shelf]);
    await db.rawExec("INSERT INTO rel_shelves (id, name) VALUES (1, 'Top')");

    const shelf: any = await db
      .getRepository(Shelf)
      .findOne(1, { relations: ["books"] });

    // Matched on `author_id`, i.e. the named property was translated to its
    // column. `Orphan` has a null key, so it belongs to no shelf.
    expect(shelf.books.map((b: any) => b.title).sort()).toEqual([
      "First",
      "Second",
    ]);
  });

  it("caches a relation-loaded read together with its relations", async () => {
    // A `Cache` with no `redisUrl` is a no-op, so this uses an in-memory one:
    // the point is that whatever `findOne` stores is what a later read gets.
    const cache = new FakeCache();
    const repo = new Repository<any>(
      db.client,
      Book,
      cache.config,
      undefined,
      cache,
    );

    const first: any = await repo.findOne(10, { relations: ["chapters"] });
    expect(first.chapters).toHaveLength(3);

    // Remove a child behind the cache's back. The next read has to be served
    // from the cache — which proves both that the cache was consulted and that
    // the entry holds the relation. The un-hydrated rows used to be cached.
    await db.rawExec("DELETE FROM rel_chapters WHERE id = 102");
    const cached: any = await repo.findOne(10, { relations: ["chapters"] });
    expect(cache.reads).toBeGreaterThan(0);
    expect(cached.chapters).toHaveLength(3);

    await cache.invalidatePattern("findOne:*");
    const reread: any = await repo.findOne(10, { relations: ["chapters"] });
    expect(reread.chapters).toHaveLength(2);

    await db.rawExec(
      "INSERT INTO rel_chapters (id, title, book_id) VALUES (102, 'Three', 10)",
    );
  });

  it("keeps a relation-loaded read out of the transaction cache", async () => {
    // Rows read inside a transaction may be rolled back, so they must never be
    // cached — the cache key is per row and would outlive the rollback.
    const cache = new FakeCache();
    const repo = new Repository<any>(
      db.client,
      Book,
      cache.config,
      undefined,
      cache,
    );

    await db.transaction(async (txClient: any) => {
      await repo.findOne(11, { relations: ["chapters"] }, txClient);
    });

    expect(cache.writes).toBe(0);
  });
});

describe("withRelations on the query builder", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Author, Book, Chapter, Tag]);
    await db.rawExec(
      "CREATE TABLE rel_book_tags (book_id INTEGER, tag_id INTEGER)",
    );
    await db.rawExec("INSERT INTO rel_authors (id, name) VALUES (1, 'Ada')");
    await db.rawExec(
      "INSERT INTO rel_books (id, title, author_id) VALUES (10, 'First', 1), (11, 'Second', 1)",
    );
    await db.rawExec(
      "INSERT INTO rel_chapters (id, title, book_id) VALUES (100, 'One', 10), (101, 'Two', 10), (102, 'Other', 11)",
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it("loads relations requested on the builder", async () => {
    // Documented in the README but never implemented: `withRelations` did not
    // exist on QueryBuilder at all.
    const books = await db
      .getRepository(Book)
      .find()
      .withRelations("chapters")
      .execute(db.client);

    expect(books).toHaveLength(2);
    expect(books[0].chapters).toHaveLength(2);
    expect(books[1].chapters).toHaveLength(1);
  });

  it("composes with where, limit and orderBy", async () => {
    const books = await db
      .getRepository(Book)
      .find()
      .where("rel_books.title = ?", "First")
      .withRelations("author", "chapters")
      .limit(1)
      .execute(db.client);

    expect(books).toHaveLength(1);
    expect(books[0].author.name).toBe("Ada");
    expect(books[0].chapters).toHaveLength(2);
  });

  it("loads a nested path", async () => {
    const books = await db
      .getRepository(Book)
      .find()
      .withRelations("chapters.book")
      .execute(db.client);

    expect(books[0].chapters[0].book.title).toBe("First");
  });

  it("accepts a list as well as separate arguments, and de-duplicates", async () => {
    const qb = db
      .getRepository(Book)
      .find()
      .withRelations(["chapters", "author"], "chapters");

    expect(qb.getRelations()).toEqual(["chapters", "author"]);
  });

  it("survives a clone", async () => {
    const qb = db.getRepository(Book).find().withRelations("chapters");
    expect(qb.clone().getRelations()).toEqual(["chapters"]);

    // countExec clones, and a count must not be affected by the relations.
    expect(await qb.clone().countExec(db.client)).toBe(2);
  });

  it("is a no-op on a builder with no repository behind it", async () => {
    // A standalone builder has no model metadata, so it simply cannot load
    // relations — but asking must not throw or corrupt the query.
    const { QueryBuilder } = await import("../query-builder");
    const rows = await new QueryBuilder("rel_books")
      .withRelations("chapters")
      .execute(db.client);

    expect(rows).toHaveLength(2);
    expect(rows[0].chapters).toBeUndefined();
  });
});

/**
 * An in-memory stand-in for Redis. The real `Cache` no-ops without a
 * `redisUrl`, which would make the caching assertions vacuous.
 */
class FakeCache extends Cache {
  private store = new Map<string, any>();
  public reads = 0;
  public writes = 0;

  constructor() {
    super({ enabled: false, ttl: 60 });
  }

  async get<T>(key: string): Promise<T | null> {
    this.reads++;
    const value = this.store.get(key);
    return value === undefined ? null : (value as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.writes++;
    // Through JSON, as Redis would: the cached shape is what a caller gets.
    this.store.set(key, JSON.parse(JSON.stringify(value)));
  }

  async invalidate(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    for (const key of [...this.store.keys()]) {
      if (re.test(key)) this.store.delete(key);
    }
  }
}
