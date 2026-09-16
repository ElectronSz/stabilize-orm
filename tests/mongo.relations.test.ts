import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType, RelationType } from "../types";
import { MONGO_COUNTERS_COLLECTION } from "../mongo-repository";

/**
 * Eager-loaded relations, against a real MongoDB server.
 *
 * Relations were the one feature that needed no algorithm change for a document
 * store, because they were already batched `IN` reads rather than joins: the
 * same shape `$in` gives. What this file has to prove is therefore narrower than
 * the SQL original — that the batched reads still land on the right rows, that
 * the grouping still gives each parent its own children, and that the link
 * collection the many-to-many side now reads and writes is the one
 * `autoMigrate` created.
 *
 * The original is `integration.relations.test.ts`, and each case below carries
 * over the failure it was written to catch.
 *
 * The suite skips itself when the replica set is not running. Start it with:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 */

const REPLICA_SET_URL =
  process.env.MONGO_URL ||
  "mongodb://127.0.0.1:57017/stabilize_test?directConnection=true&replicaSet=rs0";

/** The driver import must stay inside the try. It is an optional dependency. */
async function hasReplicaSet(url: string): Promise<boolean> {
  let client: any = null;
  try {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(url, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    const hello = await client.db().admin().command({ hello: 1 });
    return Boolean(hello.setName);
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => {});
  }
}

const available = await hasReplicaSet(REPLICA_SET_URL);
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `[skip] No replica-set MongoDB at ${REPLICA_SET_URL}. ` +
      `Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

/** Collections this file owns; dropped on the way out. */
const COLLECTIONS = [
  "rel_authors",
  "rel_books",
  "rel_chapters",
  "rel_tags",
  "rel_shelves",
  "rel_book_tags",
  MONGO_COUNTERS_COLLECTION,
];

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
    // The property name deliberately differs from the column name. Documents
    // are keyed by column name, so a relation that looked the property up
    // verbatim would filter on a field no document has and come back empty —
    // a wrong answer with no error.
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

describe("mongo relation loading", () => {
  let db: any;

  /** The exact call the SQL file makes with `rawExec`, against collections. */
  const insert = (collection: string, docs: Record<string, any>[]) =>
    db.client.mongoInsertMany(collection, docs);

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }

    // The link collection is created by `autoMigrate` here, not by hand: the
    // join table has no model, so this is the only thing that can create one,
    // and the many-to-many reads below depend on it existing.
    await db.autoMigrate([Author, Book, Chapter, Tag]);

    await insert("rel_authors", [{ _id: 1, name: "Ada" }]);
    // Book ids deliberately differ from their author's, so a child attached to
    // the wrong side of the grouping is detectable.
    await insert("rel_books", [
      { _id: 10, title: "First", author_id: 1 },
      { _id: 11, title: "Second", author_id: 1 },
      { _id: 12, title: "Orphan" },
    ]);
    await insert("rel_chapters", [
      { _id: 100, title: "One", book_id: 10 },
      { _id: 101, title: "Two", book_id: 10 },
      { _id: 102, title: "Three", book_id: 10 },
      { _id: 103, title: "Other", book_id: 11 },
    ]);
    await insert("rel_tags", [
      { _id: 1, label: "alpha" },
      { _id: 2, label: "beta" },
    ]);
    // Written raw, in the same shape `attach` writes: the composite `_id` is
    // what makes the pair unique, so a link document without one would not be
    // the document this code reads.
    await insert("rel_book_tags", [
      { _id: { p: 10, c: 2 }, book_id: 10, tag_id: 2 },
      { _id: { p: 10, c: 1 }, book_id: 10, tag_id: 1 },
      { _id: { p: 11, c: 1 }, book_id: 11, tag_id: 1 },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    await db.close();
  });

  it("attaches a to-many relation instead of dropping it", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["chapters"] });

    expect(book.chapters).toHaveLength(3);
    // Sorted by the test rather than expected in insertion order: a to-many
    // read is `find({book_id: {$in: [...]}})` with no sort, and unlike SQLite's
    // rowid scan a document store makes no promise about the order it returns.
    expect(book.chapters.map((c: any) => c.id).sort()).toEqual([
      100, 101, 102,
    ]);
  });

  it("keeps the parent row intact when a relation is loaded", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["author"] });

    expect(book.id).toBe(10);
    expect(book.title).toBe("First");
    expect(book.author).toEqual({ id: 1, name: "Ada" });
  });

  it("resolves a foreign key declared under a mapped column name", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["author"] });

    // `authorId` is stored as `author_id`, so this only works if the relation
    // translates the property to its column before building the filter.
    expect(book.author.name).toBe("Ada");
    expect(book.author_id).toBe(1);
  });

  it("gives a to-one relation null when the key is unset", async () => {
    const orphan: any = await db
      .getRepository(Book)
      .findOne(12, { relations: ["author"] });

    // `null`, not `undefined`: the relation was loaded and is genuinely empty.
    expect(orphan.author).toBeNull();
  });

  it("counts parents, not children", async () => {
    const { data, total } = await db
      .getRepository(Book)
      .findAndCount({ relations: ["chapters"] });

    expect(total).toBe(3);
    expect(data).toHaveLength(3);

    const byTitle = Object.fromEntries(
      data.map((b: any) => [b.title, b.chapters.length]),
    );
    expect(byTitle).toEqual({ First: 3, Second: 1, Orphan: 0 });
  });

  it("returns the requested number of parents, not of children", async () => {
    const books = await db
      .getRepository(Book)
      .findMany({ relations: ["chapters"], take: 2 });

    expect(books).toHaveLength(2);
    expect(new Set(books.map((b: any) => b.id)).size).toBe(2);
  });

  it("loads a many-to-many relation through its join collection", async () => {
    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["tags"] });

    // Sorted on the link `_id` rather than returned in insertion order, which
    // is the difference from the SQL file's assertion: a join table read with
    // no `ORDER BY` has no order at all, and Mongo's is not even stable between
    // two reads of unchanged data.
    expect(book.tags.map((t: any) => t.label)).toEqual(["alpha", "beta"]);
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

    // The inverse orientation reads the same collection by the other field.
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
    // Every chapter of book 10 points back at book 10, so the nested read
    // resolved the target model rather than reusing the parent.
    expect(book.chapters.every((c: any) => c.book?.title === "First")).toBe(
      true,
    );
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

    // One batched read serves every parent, so the grouping is what this pins.
    expect(byTitle["First"]).toEqual(["One", "Two", "Three"]);
    expect(byTitle["Second"]).toEqual(["Other"]);
    expect(byTitle["Orphan"]).toEqual([]);
  });

  it("omits related rows the target model soft-deleted", async () => {
    const chapters = db.getRepository(Chapter);
    await chapters.update(101, { removedAt: new Date() } as any);

    const book: any = await db
      .getRepository(Book)
      .findOne(10, { relations: ["chapters"] });

    expect(book.chapters.map((c: any) => c.id)).toEqual([100, 102]);

    await chapters.recover(101);
  });

  it("loads relations for a findBy condition", async () => {
    const books = await db
      .getRepository(Book)
      .findBy({ authorId: 1 }, { relations: ["author"] });

    expect(books).toHaveLength(2);
    expect(books[0].author.name).toBe("Ada");
  });

  it("rejects an unknown relation name", async () => {
    // Silently returning the bare row is what made the original bug hard to
    // notice. try/catch rather than `.rejects`: a rejection assertion the
    // driver never settles leaves Bun's runner hanging.
    let caught: Error | null = null;
    try {
      await db.getRepository(Book).findOne(10, { relations: ["nope"] });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toMatch(/Relation nope not found/);
  });

  it("accepts foreignKey as the name of a OneToMany's inverse column", async () => {
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
    await insert("rel_shelves", [{ _id: 1, name: "Top" }]);

    const shelf: any = await db
      .getRepository(Shelf)
      .findOne(1, { relations: ["books"] });

    // Matched on `author_id`: the named property was translated to its column.
    // `Orphan` has no key, so it belongs to no shelf.
    expect(shelf.books.map((b: any) => b.title).sort()).toEqual([
      "First",
      "Second",
    ]);
  });

  it("loads relations requested on the builder", async () => {
    const books = await db
      .getRepository(Book)
      .find()
      .withRelations("chapters")
      .execute(db.client);

    expect(books).toHaveLength(3);
    const byTitle = Object.fromEntries(
      books.map((b: any) => [b.title, b.chapters.length]),
    );
    expect(byTitle).toEqual({ First: 3, Second: 1, Orphan: 0 });
  });

  it("composes with a condition, limit and relations", async () => {
    // `whereEq` rather than the SQL file's `where("rel_books.title = ?")`:
    // there is no SQL text to send on this backend, and the raw-clause methods
    // refuse outright.
    const books = await db
      .getRepository(Book)
      .find()
      .whereEq("title", "First")
      .withRelations("author", "chapters")
      .limit(1)
      .execute(db.client);

    expect(books).toHaveLength(1);
    expect(books[0].author.name).toBe("Ada");
    expect(books[0].chapters).toHaveLength(3);
  });

  it("loads a nested path from the builder", async () => {
    const books = await db
      .getRepository(Book)
      .find()
      .withRelations("chapters.book")
      .execute(db.client);

    const first = books.find((b: any) => b.title === "First");
    expect(first.chapters).toHaveLength(3);
    expect(first.chapters.every((c: any) => c.book?.title === "First")).toBe(
      true,
    );
  });
});

describe("mongo many-to-many link management", () => {
  let db: any;

  const reset = async () => {
    await db.client.mongoDeleteMany("rel_book_tags", {});
  };

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    // Dropped rather than reused: the block above seeded the same ids, and an
    // insert of an existing `_id` fails outright.
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    await db.autoMigrate([Author, Book, Chapter, Tag]);
    await db.client.mongoInsertMany("rel_books", [
      { _id: 10, title: "First", author_id: 1 },
      { _id: 11, title: "Second", author_id: 1 },
      { _id: 12, title: "Orphan" },
    ]);
    await db.client.mongoInsertMany("rel_tags", [
      { _id: 1, label: "alpha" },
      { _id: 2, label: "beta" },
      { _id: 3, label: "gamma" },
    ]);
  });

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    await db.close();
  });

  it("attaches, and reports nothing to do the second time", async () => {
    const repo = db.getRepository(Book);

    expect(await repo.attach(10, "tags", [1, 2])).toBe(2);
    // Idempotent: the pair is already linked, so nothing is created.
    expect(await repo.attach(10, "tags", [1, 2])).toBe(0);
    expect(await repo.attach(10, "tags", 3)).toBe(1);

    const book: any = await repo.findOne(10, { relations: ["tags"] });
    expect(book.tags.map((t: any) => t.label)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("links a repeated target once", async () => {
    const repo = db.getRepository(Book);

    // The join collection carries no unique index on the pair other than its
    // `_id`, so a duplicate in the caller's list would otherwise insert twice.
    expect(await repo.attach(10, "tags", [1, 1, 1])).toBe(1);

    const links = await db.client.mongoFind("rel_book_tags", { book_id: 10 });
    expect(links).toHaveLength(1);
  });

  it("keys a link by the pair, so the storage layer enforces uniqueness", async () => {
    await db.getRepository(Book).attach(10, "tags", [1]);

    const link = await db.client.mongoFindOne("rel_book_tags", {
      book_id: 10,
      tag_id: 1,
    });
    // `_id` is the pair, not a generated value: that is what makes the second
    // insert of the same pair impossible rather than merely unlikely.
    expect(link._id).toEqual({ p: 10, c: 1 });

    // And a direct duplicate is refused by the server, which is the property
    // the SQL join table does not have.
    let caught: any = null;
    try {
      await db.client.mongoInsertOne("rel_book_tags", {
        _id: { p: 10, c: 1 },
        book_id: 10,
        tag_id: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
  });

  it("detaches one target", async () => {
    const repo = db.getRepository(Book);
    await repo.attach(10, "tags", [1, 2, 3]);

    expect(await repo.detach(10, "tags", [2])).toBe(1);

    const book: any = await repo.findOne(10, { relations: ["tags"] });
    expect(book.tags.map((t: any) => t.label)).toEqual(["alpha", "gamma"]);
  });

  it("detaches everything when no targets are named", async () => {
    const repo = db.getRepository(Book);
    await repo.attach(10, "tags", [1, 2]);
    await repo.attach(11, "tags", [1]);

    expect(await repo.detach(10, "tags")).toBe(2);

    // Only the named parent was touched, so the filter is not "every link".
    expect(
      await db.client.mongoCount("rel_book_tags", { book_id: 11 }),
    ).toBe(1);
  });

  it("syncs to exactly the given set", async () => {
    const repo = db.getRepository(Book);
    await repo.attach(10, "tags", [1, 2]);

    expect(await repo.sync(10, "tags", [2, 3])).toEqual({
      attached: 1,
      detached: 1,
    });

    const book: any = await repo.findOne(10, { relations: ["tags"] });
    expect(book.tags.map((t: any) => t.label)).toEqual(["beta", "gamma"]);
  });

  it("reports nothing to do when sync runs twice", async () => {
    const repo = db.getRepository(Book);
    await repo.sync(10, "tags", [1, 2]);

    // The second call is the idempotency assertion: if the diff were computed
    // against anything but the stored links it would report work every time.
    expect(await repo.sync(10, "tags", [1, 2])).toEqual({
      attached: 0,
      detached: 0,
    });
    expect(
      await db.client.mongoCount("rel_book_tags", { book_id: 10 }),
    ).toBe(2);
  });

  it("syncs to nothing", async () => {
    const repo = db.getRepository(Book);
    await repo.attach(10, "tags", [1, 2]);

    expect(await repo.sync(10, "tags", [])).toEqual({
      attached: 0,
      detached: 2,
    });
    expect(await repo.findOne(10, { relations: ["tags"] })).toMatchObject({
      tags: [],
    });
  });
});
