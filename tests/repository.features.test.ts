import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueryBuilder, Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType, RelationType } from "../types";

/**
 * Coverage for the features added on top of the audit fixes: aggregate
 * validation, the `*OrFail` lookups, many-to-many link management, and the raw
 * clause builders.
 */

const Signup = defineModel({
  tableName: "feat_signups",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    email: {
      type: DataTypes.STRING,
      required: true,
      pattern: /^[^@\s]+@[^@\s]+$/,
    },
    name: { type: DataTypes.STRING, required: true, minLength: 3 },
    age: {
      type: DataTypes.INTEGER,
      customValidator: (value: any) =>
        value >= 18 ? true : "Signups must be 18 or over",
    },
  },
});

const Author = defineModel({
  tableName: "feat_authors",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING, required: true },
  },
});

const Tag = defineModel({
  tableName: "feat_tags",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING, required: true },
  },
});

const Post = defineModel({
  tableName: "feat_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    authorId: { type: DataTypes.INTEGER, name: "author_id" },
  },
  relations: [
    {
      type: RelationType.ManyToMany,
      target: () => Tag,
      property: "tags",
      joinTable: "feat_post_tags",
      foreignKey: "post_id",
      inverseKey: "tag_id",
    },
    {
      type: RelationType.ManyToOne,
      target: () => Author,
      property: "author",
      foreignKey: "authorId",
    },
  ],
});

describe("validation and lookup features", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Signup, Author, Tag, Post]);
    await db.rawExec(
      "CREATE TABLE feat_post_tags (post_id INTEGER, tag_id INTEGER)",
    );
    await db.rawExec("INSERT INTO feat_authors (id, name) VALUES (1, 'Ada')");
    await db.rawExec(
      "INSERT INTO feat_posts (id, title, author_id) VALUES (10, 'First', 1), (11, 'Second', NULL)",
    );
    await db.rawExec(
      "INSERT INTO feat_tags (id, label) VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')",
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it("reports every validation failure, not just the first", async () => {
    const repo = db.getRepository(Signup);

    // Three separate problems, each of which the throwing form would hide
    // behind whichever happened to be checked first.
    expect(repo.validateAll({ email: "nope", name: "ab", age: 12 })).toEqual([
      "Field email does not match pattern",
      "Field name too short",
      "Signups must be 18 or over",
    ]);
  });

  it("reports missing required fields", async () => {
    expect(db.getRepository(Signup).validateAll({})).toEqual([
      "Field email is required",
      "Field name is required",
    ]);
  });

  it("returns no errors for a valid entity", async () => {
    expect(
      db
        .getRepository(Signup)
        .validateAll({ email: "a@b.c", name: "Ada", age: 30 }),
    ).toEqual([]);
  });

  it("can skip the required rules, as an update does", async () => {
    // A partial update supplies only the fields it changes.
    expect(db.getRepository(Signup).validateAll({ age: 30 }, true)).toEqual([]);
  });

  it("still stops at the first failure when writing", async () => {
    // The write path must not change behaviour: it throws, as before.
    await expect(
      db.getRepository(Signup).create({ email: "nope", name: "ab" }),
    ).rejects.toThrow("Field email does not match pattern");
  });

  it("findOrFail returns the row when it exists", async () => {
    const post = await db.getRepository(Post).findOrFail(10);
    expect(post.title).toBe("First");
  });

  it("findOrFail throws a named error when it does not", async () => {
    await expect(db.getRepository(Post).findOrFail(999)).rejects.toThrow(
      /feat_posts with id 999 not found/,
    );

    // The code is what a caller branches on to turn a miss into a 404.
    await expect(db.getRepository(Post).findOrFail(999)).rejects.toMatchObject(
      { code: "NOT_FOUND_ERROR" },
    );
  });

  it("findOrFail still loads relations on the way", async () => {
    const post: any = await db
      .getRepository(Post)
      .findOrFail(10, { relations: ["author"] });
    expect(post.author.name).toBe("Ada");
  });

  it("firstOrFail finds a match or throws", async () => {
    const found = await db
      .getRepository(Post)
      .firstOrFail({ title: "Second" });
    expect(found.id).toBe(11);

    await expect(
      db.getRepository(Post).firstOrFail({ title: "Nothing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND_ERROR" });
  });
});

describe("many-to-many link management", () => {
  let db: any;

  beforeAll(async () => {
    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Post, Tag, Author]);
    await db.rawExec(
      "CREATE TABLE feat_post_tags (post_id INTEGER, tag_id INTEGER)",
    );
    await db.rawExec(
      "INSERT INTO feat_posts (id, title) VALUES (20, 'Linked'), (21, 'Other')",
    );
    await db.rawExec(
      "INSERT INTO feat_tags (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  const labels = async (id: number) =>
    (await db.getRepository(Post).findOne(id, { relations: ["tags"] })).tags
      .map((t: any) => t.label)
      .sort();

  it("attaches links", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.attach(20, "tags", [1, 2])).toBe(2);
    expect(await labels(20)).toEqual(["a", "b"]);
  });

  it("attaching the same target twice is a no-op", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.attach(20, "tags", [2, 3])).toBe(1);
    expect(await labels(20)).toEqual(["a", "b", "c"]);
  });

  it("matches a string id against a numeric one", async () => {
    // Ids arrive as strings from a URL and as numbers from a read; treating
    // those as different would insert the same link a second time.
    const repo = db.getRepository(Post);
    expect(await repo.attach(20, "tags", "1")).toBe(0);
    expect(await labels(20)).toEqual(["a", "b", "c"]);
  });

  it("accepts a single id as well as a list", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.attach(21, "tags", 1)).toBe(1);
    expect(await labels(21)).toEqual(["a"]);
  });

  it("detaches specific links", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.detach(20, "tags", [2])).toBe(1);
    expect(await labels(20)).toEqual(["a", "c"]);
  });

  it("detaches every link when no targets are given", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.detach(20, "tags")).toBe(2);
    expect(await labels(20)).toEqual([]);

    // Only the named owner is affected.
    expect(await labels(21)).toEqual(["a"]);
  });

  it("detaching from an owner with no links removes nothing", async () => {
    expect(await db.getRepository(Post).detach(20, "tags")).toBe(0);
  });

  it("syncs to exactly the given set", async () => {
    const repo = db.getRepository(Post);

    // From {1} to {2, 3}: one link removed, two added.
    expect(await repo.sync(21, "tags", [2, 3])).toEqual({
      attached: 2,
      detached: 1,
    });
    expect(await labels(21)).toEqual(["b", "c"]);
  });

  it("sync leaves an already-correct set untouched", async () => {
    const repo = db.getRepository(Post);

    // Nothing to do, so nothing is written.
    expect(await repo.sync(21, "tags", [3, 2])).toEqual({
      attached: 0,
      detached: 0,
    });
    expect(await labels(21)).toEqual(["b", "c"]);
  });

  it("sync can clear the relation entirely", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.sync(21, "tags", [])).toEqual({
      attached: 0,
      detached: 2,
    });
    expect(await labels(21)).toEqual([]);
  });

  it("sync ignores a repeated id in the list", async () => {
    const repo = db.getRepository(Post);
    expect(await repo.sync(21, "tags", [1, 1])).toEqual({
      attached: 1,
      detached: 0,
    });
    expect(await labels(21)).toEqual(["a"]);
  });

  it("refuses link management on a relation that is not many-to-many", async () => {
    // Silently doing nothing would leave the caller believing it worked.
    await expect(
      db.getRepository(Post).attach(20, "author", [1]),
    ).rejects.toThrow(/needs a ManyToMany relation/);
  });

  it("rejects an unknown relation name", async () => {
    await expect(
      db.getRepository(Post).attach(20, "nope", [1]),
    ).rejects.toThrow(/Relation nope not found/);
  });
});

describe("raw clause builders", () => {
  it("orders by an expression rather than a column name", () => {
    const { query } = new QueryBuilder("posts")
      .orderByRaw("CASE WHEN status = 'urgent' THEN 0 ELSE 1 END")
      .toSQL();

    expect(query).toContain(
      "ORDER BY CASE WHEN status = 'urgent' THEN 0 ELSE 1 END",
    );
  });

  it("appends a direction to a raw order", () => {
    const { query } = new QueryBuilder("posts")
      .orderByRaw("LENGTH(title)", "DESC")
      .toSQL();

    expect(query).toContain("ORDER BY LENGTH(title) DESC");
  });

  it("groups by an expression", () => {
    const { query } = new QueryBuilder("posts")
      .select("strftime('%Y-%m', createdAt) AS month", "COUNT(*) AS n")
      .groupByRaw("strftime('%Y-%m', createdAt)")
      .toSQL();

    expect(query).toContain("GROUP BY strftime('%Y-%m', createdAt)");
  });

  it("emits HAVING after GROUP BY, with its parameters in order", () => {
    const { query, params } = new QueryBuilder("posts")
      .select("status")
      .where("author_id = ?", 7)
      .groupBy("status")
      .havingRaw("COUNT(*) > ?", 2)
      .toSQL();

    // Clause order has to be GROUP BY then HAVING, and the bound values must
    // follow the same order as their placeholders.
    expect(query.indexOf("GROUP BY")).toBeLessThan(query.indexOf("HAVING"));
    expect(query).toContain("HAVING COUNT(*) > ?");
    expect(params).toEqual([7, 2]);
  });

  it("combines raw and plain modifiers", () => {
    const { query } = new QueryBuilder("posts")
      .groupBy("status")
      .groupByRaw("strftime('%Y', createdAt)")
      .orderByRaw("COUNT(*) DESC")
      .orderBy("title")
      .toSQL();

    expect(query).toContain(
      "GROUP BY status, strftime('%Y', createdAt)",
    );
    expect(query).toContain("ORDER BY COUNT(*) DESC, title ASC");
  });
});
