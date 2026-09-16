import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType, RelationType } from "../types";
import { MONGO_COUNTERS_COLLECTION } from "../mongo-repository";

/**
 * Relations read *inside* a transaction, against a real MongoDB server.
 *
 * The client-level suite (`mongo.client.test.ts`) already proves a write inside
 * a transaction goes through the session, by rolling the transaction back and
 * watching the document disappear. What it cannot prove is the other half: that
 * a *read the ORM performs on the caller's behalf* goes through the same
 * session. `loadRelations`, `attachRelation`, `fetchRelatedWhereIn` and
 * `attachManyToMany` all take a `client` argument, and if any of them reached
 * for `this.client` instead, a relation loaded mid-transaction would read from
 * outside it: the parent would come back with an empty relation while the rows
 * it was asked for sat uncommitted a session away, and nothing would raise.
 *
 * The equivalent case exists for SQLite/Postgres in
 * `integration.relations.test.ts` ("keeps a relation-loaded read out of the
 * transaction cache"), where the failure was a cross-connection read that on
 * MySQL/Postgres deadlocks rather than merely answering wrongly. On MongoDB the
 * failure is quieter — the read simply does not see the transaction's rows —
 * which is exactly why it needs a test rather than a reviewer.
 *
 * The suite skips itself when the replica set is not running, so `bun test`
 * stays green on a machine without the fleet:
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

/**
 * Collections this file owns; dropped on the way out.
 *
 * `stabilize_counters` is deliberately *not* dropped here: it is shared with
 * every other mongo test file running in the same process, and dropping it
 * would reset counters another suite is mid-way through allocating from. The
 * per-table documents this file owns are deleted individually instead, see
 * `reset`.
 */
const COLLECTIONS = ["t8_users", "t8_posts", "t8_tags", "t8_post_tags"];

/** The counter documents this file is allowed to remove. */
const COUNTER_KEYS = ["t8_users", "t8_posts", "t8_tags"];

const User = defineModel({
  tableName: "t8_users",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    name: { type: DataTypes.STRING, required: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Post,
      property: "posts",
      inverseKey: "authorId",
    },
  ],
});

const Tag = defineModel({
  tableName: "t8_tags",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING, required: true },
  },
  relations: [
    {
      type: RelationType.ManyToMany,
      target: () => Post,
      property: "posts",
      joinTable: "t8_post_tags",
      foreignKey: "tag_id",
      inverseKey: "post_id",
    },
  ],
});

const Post = defineModel({
  tableName: "t8_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING, required: true },
    // Named differently from its column on purpose, so a relation loader that
    // skipped the name translation would filter a field that does not exist and
    // return nothing — the same silent wrong answer this file is about.
    authorId: { type: DataTypes.INTEGER, name: "author_id" },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => User,
      property: "author",
      foreignKey: "authorId",
    },
    {
      type: RelationType.ManyToMany,
      target: () => Tag,
      property: "tags",
      joinTable: "t8_post_tags",
      foreignKey: "post_id",
      inverseKey: "tag_id",
    },
  ],
});

suite("mongo relations inside a transaction", () => {
  let db: any;
  let users: any;
  let posts: any;
  let tags: any;

  /**
   * An empty set of rows and a counter back at zero, so every case can assert
   * on absolute ids rather than on what the previous case left behind.
   *
   * `deleteMany` rather than `drop`: the validator and the indexes `autoMigrate`
   * installed are part of what these cases rely on, and a drop takes them with
   * it. The counter is reset per table, never as a collection.
   */
  const reset = async () => {
    for (const name of COLLECTIONS) {
      await db.client.mongoDeleteMany(name, {});
    }
    for (const table of COUNTER_KEYS) {
      await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
        _id: table,
      });
    }
    // Reference data, rewritten on every case so a case that links tags cannot
    // be affected by one that did.
    await db.client.mongoInsertMany("t8_tags", [
      { _id: 1, label: "alpha" },
      { _id: 2, label: "beta" },
      { _id: 3, label: "gamma" },
    ]);
  };

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }

    // `autoMigrate` is what creates `t8_post_tags`: the join table has no model
    // of its own, so nothing else can. The many-to-many cases below depend on it
    // existing, and on the link documents `attach` writes having the shape the
    // read expects.
    await db.autoMigrate([User, Post, Tag]);

    users = db.getRepository(User);
    posts = db.getRepository(Post);
    tags = db.getRepository(Tag);
  });

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
    // Only this file's counter documents, for the reason given on COUNTER_KEYS.
    try {
      for (const table of COUNTER_KEYS) {
        await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
          _id: table,
        });
      }
    } catch {
      // Nothing to clean if the connection is already gone.
    }
    await db.close();
  });

  // ─── the gate: relations read on the transaction's own client ──────

  it("loads a relation on the client it was given, not the repository's own", async () => {
    // The sharpest form of the question, because the parent is committed and
    // visible to both clients: only the *children* differ between the two reads,
    // so nothing about the parent read can explain the answer either way.
    //
    // Reading it on the root client must show the child that is already
    // committed. Reading it on the transaction's client must show that child
    // *and* the one this transaction has not committed yet. `loadRelations`
    // reaches the children through `fetchRelatedWhereIn`, which builds the
    // target model's query and executes it against the client it was handed —
    // through `relatedRepository`, which binds the target model to that same
    // client. Had either reached for `this.client`, the second read would agree
    // with the first, and this is the assertion that would catch it.
    const user: any = await users.create({ name: "Ada" });
    await posts.create({ title: "committed", authorId: user.id });

    await db.transaction(async (tx: any) => {
      await posts.create({ title: "in-flight", authorId: user.id }, {}, tx);

      const outside: any = await users.findOne(user.id, {
        relations: ["posts"],
      });
      expect(outside.posts.map((post: any) => post.title)).toEqual([
        "committed",
      ]);

      const inside: any = await users.findOne(
        user.id,
        { relations: ["posts"] },
        tx,
      );
      expect(inside.posts.map((post: any) => post.title).sort()).toEqual([
        "committed",
        "in-flight",
      ]);
    });
  });

  it("sees a one-to-many relation built inside the transaction", async () => {
    let sawOutside: boolean | null = null;

    await db.transaction(async (tx: any) => {
      const user: any = await users.create({ name: "Ada" }, {}, tx);
      await posts.create({ title: "One", authorId: user.id }, {}, tx);
      await posts.create({ title: "Two", authorId: user.id }, {}, tx);

      // The assertion this file exists for. `loadRelations` reaches the children
      // through `fetchRelatedWhereIn`, which runs the target model's `find()`
      // against the client it was handed. Handed the root client instead, this
      // read would run outside the transaction, match nothing, and attach an
      // empty array — the parent would still be found, so only the relation
      // count tells the two apart.
      const read: any = await users.findOne(
        user.id,
        { relations: ["posts"] },
        tx,
      );
      expect(read.posts.map((post: any) => post.title).sort()).toEqual([
        "One",
        "Two",
      ]);

      // Control. The same document read through the *root* client is not there,
      // so the visibility above is the session's doing and not a dirty read that
      // would have made the assertion pass for the wrong reason.
      sawOutside = (await users.findOne(user.id)) !== null;
    });

    expect(sawOutside).toBe(false);

    // And the commit did make it all permanent, so the case is not passing by
    // leaving everything uncommitted.
    const committed: any = await users.findOne(1, { relations: ["posts"] });
    expect(committed.posts).toHaveLength(2);
  });

  it("sees a many-to-many link attached inside the transaction", async () => {
    await db.transaction(async (tx: any) => {
      const post: any = await posts.create({ title: "Linked" }, {}, tx);

      // `attach` reads the existing links through `mongoFetchLinkedIds` and
      // writes the missing ones through `mongoAttachLinks`, both with the client
      // it was given. On the root client the read would see no links, every
      // pair would look missing, and the write would land outside the
      // transaction — so this count is the session reaching the link collection.
      const attached = await posts.attach(post.id, "tags", [1, 2], tx);
      expect(attached).toBe(2);

      // Read back through `mongoFindLinks`, the other half of the same
      // question: the link collection was written on the session, and it has to
      // be read on the session too.
      const read: any = await posts.findOne(
        post.id,
        { relations: ["tags"] },
        tx,
      );
      expect(read.tags.map((tag: any) => tag.label)).toEqual([
        "alpha",
        "beta",
      ]);

      // The inverse orientation reads the same documents by the other field, so
      // it exercises a differently-shaped link read rather than the same one
      // twice.
      const inverse: any = await tags.findOne(1, { relations: ["posts"] }, tx);
      expect(inverse.posts.map((p: any) => p.title)).toEqual(["Linked"]);
    });

    // Committed, so the link outlives the transaction it was made in.
    const after: any = await posts.findOne(1, { relations: ["tags"] });
    expect(after.tags.map((tag: any) => tag.label)).toEqual(["alpha", "beta"]);
    expect(await db.client.mongoCount("t8_post_tags", {})).toBe(2);
  });

  // ─── rollback ──────────────────────────────────────────────────────

  it("rolls back the parent, the children and the link together", async () => {
    let userId: any = null;
    let postId: any = null;

    // try/catch rather than `.rejects`: a rejection assertion the driver never
    // settles leaves Bun's runner hanging.
    let thrown: unknown = null;
    try {
      await db.transaction(async (tx: any) => {
        const user: any = await users.create({ name: "doomed" }, {}, tx);
        userId = user.id;
        const post: any = await posts.create(
          { title: "doomed", authorId: user.id },
          {},
          tx,
        );
        postId = post.id;
        await posts.attach(post.id, "tags", [1, 2], tx);

        // Read inside, so the case also pins that the rows were genuinely there
        // before the rollback rather than never written at all.
        const read: any = await users.findOne(
          user.id,
          { relations: ["posts"] },
          tx,
        );
        expect(read.posts).toHaveLength(1);

        throw new Error("deliberate");
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error)?.message).toBe("deliberate");

    // None of the three collections kept anything, which is the property the
    // session is supposed to give: one rollback undoes the parent, the child
    // that points at it, and the link between the child and a tag — the three
    // writes being one unit of work rather than three unrelated statements.
    expect(await db.client.mongoFindOne("t8_users", { _id: userId })).toBeNull();
    expect(await db.client.mongoFindOne("t8_posts", { _id: postId })).toBeNull();
    expect(await db.client.mongoCount("t8_post_tags", {})).toBe(0);

    // Nothing is visible through the repository either, which is the answer a
    // caller would actually receive.
    expect(await users.findOne(userId)).toBeNull();
    expect(await posts.findOne(postId, { relations: ["tags"] })).toBeNull();
    expect(await users.count()).toBe(0);
  });

  it("rolls back the id allocation with the transaction", async () => {
    // A deliberate divergence from MySQL and SQLite, where auto-increment does
    // not roll back: an id burned by an aborted transaction is gone for good
    // there. Here the counter `$inc` runs through the transaction's session, so
    // the reservation is undone with everything else and the next write reuses
    // the id. Pinned as a decision, not left as an accident — a caller that
    // assumed the SQL behaviour would see ids repeat across a rollback.
    let allocatedId: any = null;

    try {
      await db.transaction(async (tx: any) => {
        const user: any = await users.create({ name: "never" }, {}, tx);
        allocatedId = user.id;
        expect(allocatedId).toBe(1);
        throw new Error("deliberate");
      });
    } catch {
      // Expected; the assertion is on what the counter holds afterwards.
    }

    expect(await users.count()).toBe(0);

    // Had the `$inc` committed on its own, this would be 2.
    const survivor: any = await users.create({ name: "survivor" });
    expect(survivor.id).toBe(1);
  });

  // ─── snapshot isolation ────────────────────────────────────────────

  it("does not see a row written outside the transaction after its snapshot", async () => {
    // `withTransaction` opens the transaction with `readConcern: {level:
    // "snapshot"}`, which fixes what the transaction can see at its first
    // operation. Deterministic because it is the read concern that decides it,
    // not a race: the outside write is made *after* the snapshot and is read
    // back from outside before the transaction asks again.
    let sawLateRow: boolean | null = null;
    let lateRowIsCommitted: boolean | null = null;

    await db.transaction(async (tx: any) => {
      await posts.create({ title: "early" }, {}, tx);
      // First read: the snapshot exists from here on.
      expect(await posts.findOne(1, {}, tx)).not.toBeNull();

      // Written with a raw insert rather than through the repository, so it
      // does not touch the counter document the open transaction has just
      // incremented — an `$inc` on that document from outside would be a write
      // conflict, and `withTransaction` would replay this callback rather than
      // let the case observe anything.
      // The validator `autoMigrate` installed requires `title` and types every
      // declared column, so this carries exactly what `t8_posts` allows. An
      // explicit `author_id: null` would be rejected as a document-validation
      // failure, not as the conflict being tested for.
      await db.client.mongoInsertOne("t8_posts", {
        _id: 9001,
        title: "late",
      });

      // Committed and readable from outside the transaction, so its absence
      // below cannot be explained by the write not having happened.
      lateRowIsCommitted =
        (await db.client.mongoFindOne("t8_posts", { _id: 9001 })) !== null;

      sawLateRow = (await posts.findOne(9001, {}, tx)) !== null;
    });

    expect(lateRowIsCommitted).toBe(true);
    expect(sawLateRow).toBe(false);

    // The row is there for everyone else, which is the point: the transaction
    // read its own snapshot rather than the current state.
    expect(await db.client.mongoFindOne("t8_posts", { _id: 9001 })).not.toBeNull();
  });

  it("holds its own uncommitted writes apart from a same-collection read outside", async () => {
    // The complement of the case above, from the other side: a transaction's
    // own writes are invisible to reads outside it, while its relation reads
    // still see them. Both directions together are what makes the visibility
    // asserted earlier attributable to the session rather than to the read
    // concern.
    let outsideSawParent: boolean | null = null;
    let outsideSawChild: boolean | null = null;

    await db.transaction(async (tx: any) => {
      const user: any = await users.create({ name: "in-flight" }, {}, tx);
      await posts.create({ title: "in-flight", authorId: user.id }, {}, tx);

      outsideSawParent = (await users.findOne(user.id)) !== null;
      // Raw, so the answer does not depend on the repository's soft-delete and
      // relation handling: the transaction's child is not in the collection yet.
      outsideSawChild = (await db.client.mongoFind("t8_posts", {})).length > 0;

      // Still visible inside, in the same breath.
      const read: any = await users.findOne(
        user.id,
        { relations: ["posts"] },
        tx,
      );
      expect(read.posts).toHaveLength(1);
    });

    expect(outsideSawParent).toBe(false);
    expect(outsideSawChild).toBe(false);
  });
});
