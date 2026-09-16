import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType, RelationType } from "../types";
import {
  buildValidatorFromColumns,
  generateMongoSteps,
  mapColumnToBsonSchema,
  planMongoCollection,
  planMongoLinkCollections,
} from "../mongo-schema";
import {
  MONGO_MIGRATIONS_COLLECTION,
  generateMongoMigration,
  runMongoMigrations,
} from "../mongo-migrate";
import { MONGO_COUNTERS_COLLECTION } from "../mongo-repository";

/**
 * Schema derivation and migrations for the MongoDB backend.
 *
 * The first half is pure — no server, no client — because the whole point of
 * expressing a MongoDB migration as data rather than as closures is that it can
 * be asserted by reading it. The second half needs a real server, because the
 * two rules that matter most (`validationLevel: "moderate"` and `sparse: true`)
 * are only observable in what the server then *lets through*: a validator that
 * was requested but never installed is indistinguishable from one that was, and
 * a non-sparse unique index only misbehaves on the second document that omits
 * the field.
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

// ─── pure: the derived schema ────────────────────────────────────────

const Account = defineModel({
  tableName: "m4_accounts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    // Unique but deliberately *not* required: a sparse unique index only
    // matters for a column a document is allowed to omit.
    email: { type: DataTypes.STRING, unique: true },
    handle: { type: DataTypes.STRING, required: true, index: "idx_handle" },
    age: { type: DataTypes.INTEGER },
    nickname: { type: DataTypes.STRING },
    bio: { type: DataTypes.TEXT, maxLength: 280 },
    secret: { type: DataTypes.STRING, encrypted: true },
  },
});

const Post = defineModel({
  tableName: "m4_posts",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    title: { type: DataTypes.STRING },
  },
  relations: [
    {
      type: RelationType.ManyToMany,
      target: () => Account,
      property: "accounts",
      joinTable: "m4_post_accounts",
      foreignKey: "post_id",
      inverseKey: "account_id",
    },
  ],
});

describe("mongo schema derivation", () => {
  it("accepts the several BSON types a JavaScript integer becomes", () => {
    // A driver turns a JS integer into `int` inside 32-bit range and `double`
    // beyond it, so a schema demanding only `int` would reject every id past
    // two billion.
    expect(mapColumnToBsonSchema({ type: DataTypes.INTEGER }).bsonType).toEqual([
      "int",
      "long",
      "double",
    ]);
  });

  it("validates an encrypted column as a string whatever it was declared", () => {
    // The ciphertext is what is stored; validating it against the declared type
    // would reject every write.
    expect(
      mapColumnToBsonSchema({ type: DataTypes.INTEGER, encrypted: true })
        .bsonType,
    ).toBe("string");
  });

  it("folds the model's own validators into the BSON schema", () => {
    const bio = mapColumnToBsonSchema({ type: DataTypes.TEXT, maxLength: 280 });
    expect(bio.maxLength).toBe(280);

    const code = mapColumnToBsonSchema({
      type: DataTypes.STRING,
      minLength: 2,
      pattern: /^[A-Z]+$/,
    });
    expect(code.minLength).toBe(2);
    // A `RegExp` does not survive a round trip through an aggregation; its
    // source does.
    expect(code.pattern).toBe("^[A-Z]+$");
  });

  it("keeps a DATETIME a date rather than a string", () => {
    expect(mapColumnToBsonSchema({ type: DataTypes.DATETIME }).bsonType).toEqual(
      ["date", "string"],
    );
  });

  it("requires _id and the required columns, and does not seal the object", () => {
    const plan = planMongoCollection(Account)!;
    const schema = plan.validator.$jsonSchema;

    expect(schema.required).toContain("_id");
    expect(schema.required).toContain("handle");
    expect(schema.required).not.toContain("email");
    expect(schema.required).not.toContain("nickname");

    // Deliberately not false: rejecting undeclared fields would stop the
    // collection being schemaless, and would make autoMigrate a one-way door.
    expect(schema.additionalProperties).toBeUndefined();
    // The primary key is `_id`; there is no separate `id` field to declare.
    expect(schema.properties.id).toBeUndefined();
  });

  it("marks every unique index sparse", () => {
    const plan = planMongoCollection(Account)!;
    const unique = plan.indexes.filter((index) => index.options.unique);

    expect(unique).toHaveLength(1);
    expect(unique[0]!.spec).toEqual({ email: 1 });
    // Without `sparse`, two documents that both omit `email` are both null to
    // MongoDB and collide — where SQL treats two NULLs as distinct.
    expect(unique[0]!.options.sparse).toBe(true);
  });

  it("honours a declared index name", () => {
    const plan = planMongoCollection(Account)!;
    const named = plan.indexes.find((index) => index.options.name === "idx_handle");
    expect(named!.spec).toEqual({ handle: 1 });
  });

  it("keys a many-to-many link by a compound _id", () => {
    const plans = planMongoLinkCollections([Post]);
    expect(plans).toHaveLength(1);

    const link = plans[0]!;
    expect(link.collection).toBe("m4_post_accounts");
    // Compound `_id` so `attach` is idempotent at the storage layer rather than
    // by a read the caller has to perform first.
    expect(link.validator.$jsonSchema.properties._id).toEqual({
      bsonType: "object",
    });
    expect(link.indexes.map((index) => Object.keys(index.spec)[0])).toEqual([
      "account_id",
      "post_id",
    ]);
  });

  it("generates a migration whose steps are data", () => {
    const migration = generateMongoMigration(Account, "create_m4_accounts");

    // The SQL halves stay empty: they are SQL, and there is none here.
    expect(migration.up).toEqual([]);
    expect(migration.down).toEqual([]);
    expect(migration.mongoDown).toEqual([
      { kind: "dropCollection", collection: "m4_accounts" },
    ]);

    const kinds = migration.mongoUp!.map((step) => step.kind);
    expect(kinds[0]).toBe("createCollection");
    expect(kinds).toContain("createIndex");
    // The counter step comes last, and only because the key is generated.
    expect(kinds[kinds.length - 1]).toBe("createCounter");
  });

  it("generates no counter for a caller-supplied key", () => {
    const Token = defineModel({
      tableName: "m4_tokens",
      columns: {
        id: { type: DataTypes.STRING, required: true },
        value: { type: DataTypes.STRING },
      },
    });
    const migration = generateMongoMigration(Token, "create_m4_tokens");
    expect(migration.mongoUp!.map((step) => step.kind)).not.toContain(
      "createCounter",
    );
  });

  it("drops the collection as the only inverse", () => {
    // Dropping is total in a way that dropping indexes one by one is not: the
    // validator goes with it, so a re-`up` rebuilds from the declaration.
    expect(generateMongoSteps(Account, "down")).toEqual([
      { kind: "dropCollection", collection: "m4_accounts" },
    ]);
  });

  it("builds a validator with no id column to declare", () => {
    const validator = buildValidatorFromColumns(
      { id: { type: DataTypes.INTEGER }, name: { type: DataTypes.STRING } },
      "id",
    );
    expect(validator.$jsonSchema.required).toEqual(["_id"]);
    expect(Object.keys(validator.$jsonSchema.properties)).toEqual(["name"]);
  });
});

// ─── against a server ────────────────────────────────────────────────

const available = await hasReplicaSet(REPLICA_SET_URL);
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `[skip] No replica-set MongoDB at ${REPLICA_SET_URL}. ` +
      `Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

const COLLECTIONS = [
  "m4_accounts",
  "m4_posts",
  "m4_post_accounts",
  MONGO_COUNTERS_COLLECTION,
  MONGO_MIGRATIONS_COLLECTION,
];

suite("mongo autoMigrate", () => {
  let db: any;

  const dropAll = async () => {
    for (const name of COLLECTIONS) {
      await db.client.mongoCommand({ drop: name }).catch(() => {});
    }
  };

  beforeAll(async () => {
    db = new Stabilize({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await db.client.mongoCommand({ ping: 1 });
    await dropAll();
  });

  afterAll(async () => {
    if (!db) return;
    await dropAll().catch(() => {});
    await db.close();
  });

  it("creates the collection, its indexes and its validator", async () => {
    await db.autoMigrate([Account, Post]);

    const names = (await db.client.mongoListCollections()).map(
      (entry: any) => entry.name,
    );
    expect(names).toContain("m4_accounts");
    // The many-to-many join table has no model of its own, so autoMigrate is
    // the only thing that can create it.
    expect(names).toContain("m4_post_accounts");

    const indexes = await db.client.mongoListIndexes("m4_accounts");
    const email = indexes.find((index: any) => index.key?.email === 1);
    expect(email).toBeDefined();
    expect(email.unique).toBe(true);
    // The assertion that matters: a non-sparse unique index only misbehaves on
    // the second document that omits the field.
    expect(email.sparse).toBe(true);
  });

  it("installs the validator, not just asks for one", async () => {
    const info = await db.client.mongoCommand({ listCollections: 1 });
    const account = info.cursor.firstBatch.find(
      (entry: any) => entry.name === "m4_accounts",
    );
    expect(account.options.validationLevel).toBe("moderate");
    expect(account.options.validator.$jsonSchema.bsonType).toBe("object");
  });

  it("rejects a document the schema says is the wrong type", async () => {
    // Proves the validator runs, rather than merely being present in options.
    let rejected = false;
    try {
      await db.client.mongoInsertOne("m4_accounts", {
        _id: 9901,
        // `handle` is supplied so the document is rejected for the wrong type
        // rather than for the missing required field.
        handle: "typed",
        email: "typed@example.com",
        age: "not a number",
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it("lets a document omit a unique column twice", async () => {
    const repo = db.getRepository(Account);
    await repo.create({ email: "first@example.com", handle: "first" });
    // Two documents that both *omit* `email` are both null to MongoDB. Without
    // `sparse` the second of these is rejected, where SQL would allow it.
    const second: any = await repo.create({ handle: "second" });
    expect(second.id).toBeGreaterThan(0);

    const raw = await db.client.mongoFindOne("m4_accounts", {
      _id: second.id,
    });
    expect("email" in raw).toBe(false);
  });

  it("updates a document that predates a newly declared required field", async () => {
    // The `moderate` assertion. Under the default `"strict"`, this update is
    // rejected — so `repo.update()` would fail on exactly the rows autoMigrate
    // just declared a field for.
    const Extended = defineModel({
      tableName: "m4_accounts",
      columns: {
        id: { type: DataTypes.INTEGER, required: true },
        email: { type: DataTypes.STRING, unique: true },
        handle: { type: DataTypes.STRING, required: true, index: "idx_handle" },
        age: { type: DataTypes.INTEGER },
        nickname: { type: DataTypes.STRING },
        bio: { type: DataTypes.TEXT, maxLength: 280 },
        secret: { type: DataTypes.STRING, encrypted: true },
        // Newly declared and required. The documents written above do not have
        // it.
        region: { type: DataTypes.STRING, required: true },
      },
    });

    await db.autoMigrate([Extended]);

    const raw = await db.client.mongoFindOne("m4_accounts", {
      handle: "second",
    });
    expect(raw.region).toBeUndefined();

    // The whole point: this must not throw.
    await db.client.mongoUpdateOne(
      "m4_accounts",
      { _id: raw._id },
      { $set: { nickname: "still no region" } },
    );
    const after = await db.client.mongoFindOne("m4_accounts", { _id: raw._id });
    expect(after.nickname).toBe("still no region");
  });

  it("is a no-op the second time", async () => {
    // No `NamespaceExists` and no `IndexOptionsConflict`, which is what a
    // naive re-run would produce.
    await db.autoMigrate([Account, Post]);
    await db.autoMigrate([Account, Post]);
    const names = (await db.client.mongoListCollections()).map(
      (entry: any) => entry.name,
    );
    expect(names.filter((name: string) => name === "m4_accounts")).toHaveLength(1);
  });

  it("pre-creates a counter so the first concurrent write cannot race", async () => {
    const counter = await db.client.mongoFindOne(MONGO_COUNTERS_COLLECTION, {
      _id: "m4_accounts",
    });
    expect(counter.seq).toBeGreaterThanOrEqual(0);
  });

  it("runs a generated migration and records it in the ledger", async () => {
    await db.client.mongoCommand({ drop: "m4_tokens" }).catch(() => {});
    await db.client.mongoDeleteMany(MONGO_MIGRATIONS_COLLECTION, {
      _id: "create_m4_tokens",
    });

    const Token = defineModel({
      tableName: "m4_tokens",
      columns: {
        id: { type: DataTypes.INTEGER, required: true },
        value: { type: DataTypes.STRING, unique: true },
      },
    });

    const migration = generateMongoMigration(Token, "create_m4_tokens");
    await runMongoMigrations(
      { type: DBType.MongoDB, connectionString: REPLICA_SET_URL },
      [migration],
    );

    const ledger = await db.client.mongoFindOne(MONGO_MIGRATIONS_COLLECTION, {
      _id: "create_m4_tokens",
    });
    expect(ledger).not.toBeNull();
    expect(ledger.applied_at).toBeInstanceOf(Date);

    const indexes = await db.client.mongoListIndexes("m4_tokens");
    expect(indexes.some((index: any) => index.key?.value === 1)).toBe(true);

    // Idempotent: the ledger entry is what stops a second application.
    await runMongoMigrations(
      { type: DBType.MongoDB, connectionString: REPLICA_SET_URL },
      [migration],
    );

    await db.client.mongoCommand({ drop: "m4_tokens" }).catch(() => {});
    await db.client.mongoDeleteMany(MONGO_COUNTERS_COLLECTION, {
      _id: "m4_tokens",
    });
  });

  it("refuses a migration that carries SQL for a MongoDB target", async () => {
    // Reporting success for steps that were never run would be worse than
    // failing.
    let message = "";
    try {
      await runMongoMigrations(
        { type: DBType.MongoDB, connectionString: REPLICA_SET_URL },
        [
          {
            name: "sql_only_m4",
            up: ["CREATE TABLE nope (id INT)"],
            down: [],
          },
        ],
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("no MongoDB steps");
  });
});
