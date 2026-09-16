import { describe, it, expect, afterAll } from "vitest";
import { DBClient } from "../client";
import { DBType, StabilizeError, type Logger, type PoolMetrics } from "../types";

/**
 * Client-level coverage for the MongoDB backend.
 *
 * Repository coverage lives in `integration.mongo.test.ts`; this file is about
 * the layer beneath it — connecting, the raw-SQL guard, and above all
 * *transactions*, which for MongoDB are the whole ballgame. Every write in the
 * ORM is wrapped in one, so a server that cannot serve them cannot store
 * anything, and the way that fails is quiet: the connection is fine, reads
 * work, and only writes break.
 *
 * Two servers are needed to pin that down, both from the compose fleet:
 *
 *   - a single-node replica set on 57017, where transactions work;
 *   - a standalone on 57018, where they cannot, so the warning and the error
 *     message that explain the situation can be asserted rather than assumed.
 *
 * Each suite skips itself when its server is absent, so `bun test` stays green
 * on a machine without the fleet. Start it with:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 */

const REPLICA_SET_URL =
  process.env.MONGO_URL ||
  "mongodb://127.0.0.1:57017/stabilize_test?directConnection=true&replicaSet=rs0";

const STANDALONE_URL =
  process.env.MONGO_STANDALONE_URL ||
  "mongodb://127.0.0.1:57018/stabilize_test?directConnection=true";

/**
 * A logger that keeps what it was told, so a warning can be asserted.
 *
 * `StabilizeLogger` writes to the console, which would make the assertion a
 * matter of reading test output by eye.
 */
class RecordingLogger implements Logger {
  public warnings: string[] = [];
  public debugMessages: string[] = [];

  logQuery(): void {}
  logError(): void {}
  logMetrics(_metrics: PoolMetrics): void {}
  logInfo(): void {}
  logWarn(message: string): void {
    this.warnings.push(message);
  }
  logDebug(message: string): void {
    this.debugMessages.push(message);
  }
}

/**
 * Reports whether a server answers *and* has the replica-set property asked for.
 *
 * Both halves matter, and the second is the one that would be missed. A
 * standalone pings perfectly well — so a probe that only pinged would call the
 * standalone "available" and hand the replica-set suite a server on which every
 * write fails. Asking `hello` for `setName` is what tells the two apart.
 *
 * The driver import is inside the `try` on purpose: `mongodb` is an optional
 * dependency, and a top-level import would break `bun test` for anyone who has
 * not installed it.
 */
async function probe(url: string, wantReplicaSet: boolean): Promise<boolean> {
  let client: any = null;
  try {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(url, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    const hello = await client.db().admin().command({ hello: 1 });
    return wantReplicaSet ? Boolean(hello.setName) : !hello.setName;
  } catch {
    return false;
  } finally {
    // `close()` on a client that never connected rejects; the answer is already
    // known by then, so that failure is not worth surfacing.
    await client?.close().catch(() => {});
  }
}

const hasReplicaSet = await probe(REPLICA_SET_URL, true);
const hasStandalone = await probe(STANDALONE_URL, false);

const suite = hasReplicaSet ? describe : describe.skip;
const standaloneSuite = hasStandalone ? describe : describe.skip;

if (!hasReplicaSet) {
  console.warn(
    `[skip] No replica-set MongoDB at ${REPLICA_SET_URL}. ` +
      `Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}
if (!hasStandalone) {
  console.warn(
    `[skip] No standalone MongoDB at ${STANDALONE_URL}. ` +
      `Run: docker compose -f docker-compose.test.yml up -d --wait`,
  );
}

/** Collection names this file owns; dropped on the way out. */
const COLLECTIONS = ["m0_commit", "m0_rollback", "m0_duplicate"];

afterAll(async () => {
  if (!hasReplicaSet) return;
  const client = new DBClient({
    type: DBType.MongoDB,
    connectionString: REPLICA_SET_URL,
  });
  try {
    for (const name of COLLECTIONS) {
      await client.mongoDeleteMany(name, {});
    }
  } finally {
    await client.close();
  }
});

suite("DBClient against MongoDB", () => {
  it("connects and answers a command", async () => {
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    try {
      const pong = await client.mongoCommand({ ping: 1 });
      expect(pong.ok).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("reads back a document it wrote outside a transaction", async () => {
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    try {
      await client.mongoDeleteMany("m0_commit", {});
      await client.mongoInsertOne("m0_commit", { _id: 1, value: "plain" });

      const docs = await client.mongoFind("m0_commit", {});
      expect(docs).toHaveLength(1);
      expect(docs[0].value).toBe("plain");
      // `_id` is what a mongo document's primary key is called; the ORM maps it
      // to the model's `id` further up. Pinning the raw shape here keeps that
      // mapping honest.
      expect(docs[0]._id).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("commits a transaction", async () => {
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    try {
      await client.mongoDeleteMany("m0_commit", {});
      await client.transaction(async (tx) => {
        await tx.mongoInsertOne("m0_commit", { _id: 10, value: "committed" });
      });

      const docs = await client.mongoFind("m0_commit", {});
      expect(docs.map((d) => d.value)).toEqual(["committed"]);
    } finally {
      await client.close();
    }
  });

  it("rolls back a transaction", async () => {
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    try {
      await client.mongoDeleteMany("m0_rollback", {});

      // try/catch rather than `.rejects`: a rejection assertion that the driver
      // never settles leaves Bun's runner hanging.
      let thrown: unknown = null;
      try {
        await client.transaction(async (tx) => {
          await tx.mongoInsertOne("m0_rollback", { _id: 20, value: "nope" });
          throw new Error("deliberate");
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("deliberate");

      const docs = await client.mongoFind("m0_rollback", {});
      expect(docs).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("runs a write inside a transaction through the session", async () => {
    // The distinction being pinned: without the session option the insert would
    // still land, but *outside* the transaction, so a later rollback would
    // leave it behind. This asserts the session actually reaches the command.
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    try {
      await client.mongoDeleteMany("m0_rollback", {});

      let readInside: unknown[] | null = null;
      try {
        await client.transaction(async (tx) => {
          await tx.mongoInsertOne("m0_rollback", { _id: 21, value: "in-flight" });
          // Visible to the transaction's own session.
          readInside = await tx.mongoFind("m0_rollback", { _id: 21 });
          throw new Error("deliberate");
        });
      } catch {
        // Expected; the assertion is on what the rollback left behind.
      }

      expect(readInside).toHaveLength(1);
      expect(await client.mongoFind("m0_rollback", { _id: 21 })).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("refuses raw SQL with MONGO_UNSUPPORTED", async () => {
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    try {
      const caught: StabilizeError[] = [];
      for (const attempt of [
        () => client.query("SELECT 1"),
        () => client.queryExec("DELETE FROM nothing"),
        () => client.migrationQuery("CREATE TABLE nothing (id INT)"),
      ]) {
        try {
          await attempt();
        } catch (error) {
          caught.push(error as StabilizeError);
        }
      }

      expect(caught).toHaveLength(3);
      for (const error of caught) {
        expect(error).toBeInstanceOf(StabilizeError);
        expect(error.code).toBe("MONGO_UNSUPPORTED");
      }
    } finally {
      await client.close();
    }
  });

  it("lets a write the driver refused keep its own error code", async () => {
    // The other half of the rule the standalone suite pins from the far side. A
    // duplicate key is not a transaction problem, and reporting it as one would
    // send the reader to the server's replica-set configuration when the answer
    // is "that id is taken". The distinction that makes this reachable: the
    // executor wraps the driver's rejection in a `MONGO_ERROR` whose `code` is a
    // string, so its own number is gone by the time the classifier runs.
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    try {
      await client.mongoDeleteMany("m0_duplicate", {});
      await client.mongoInsertOne("m0_duplicate", { _id: 1 });

      let caught: StabilizeError | null = null;
      try {
        await client.transaction(async (tx) => {
          await tx.mongoInsertOne("m0_duplicate", { _id: 1 });
        });
      } catch (error) {
        caught = error as StabilizeError;
      }

      expect(caught).toBeInstanceOf(StabilizeError);
      expect(caught!.code).toBe("MONGO_ERROR");
      // The driver's own reason survives, so the failure stays diagnosable.
      expect(caught!.message).toMatch(/duplicate key|E11000/i);
      expect(caught!.message).not.toMatch(/replica set/i);
    } finally {
      await client.mongoDeleteMany("m0_duplicate", {});
      await client.close();
    }
  });

  it("closes a client that was never connected", async () => {
    // The handle is filled in lazily, so `close()` runs against `null` when
    // nothing ever used the client. It has to be a no-op rather than a throw.
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: REPLICA_SET_URL,
    });
    await client.close();
  });
});

standaloneSuite("DBClient against a standalone MongoDB", () => {
  it("warns at connect time that transactions are unavailable", async () => {
    const logger = new RecordingLogger();
    const client = new DBClient(
      { type: DBType.MongoDB, connectionString: STANDALONE_URL },
      logger,
    );
    try {
      // The warning is emitted during the lazy connect, which the first command
      // triggers.
      await client.mongoCommand({ ping: 1 });

      const warnings = logger.warnings.join("\n");
      expect(warnings).toContain("standalone");
      expect(warnings).toContain("replica set");
    } finally {
      await client.close();
    }
  });

  it("reports a transaction failure as a TX_ERROR naming the fix", async () => {
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: STANDALONE_URL,
    });
    try {
      let caught: StabilizeError | null = null;
      try {
        await client.transaction(async (tx) => {
          // A real write, not a `ping`: mongo rejects some administrative
          // commands inside a transaction for reasons unrelated to the replica
          // set ("This command is not supported in transactions"), which would
          // mask the failure actually under test.
          await tx.mongoInsertOne("m0_standalone_tx", { _id: 1 });
        });
      } catch (error) {
        caught = error as StabilizeError;
      }

      expect(caught).toBeInstanceOf(StabilizeError);
      expect(caught!.code).toBe("TX_ERROR");
      // The point of the custom message: the driver's own wording ("Transaction
      // numbers are only allowed on a replica set member or mongos") names the
      // rule but not the remedy.
      expect(caught!.message).toMatch(/replica set/i);
      expect(caught!.message).toMatch(/rs\.initiate/);
    } finally {
      await client.close();
    }
  });

  it("still serves reads, which is why the warning is not fatal", async () => {
    const client = new DBClient({
      type: DBType.MongoDB,
      connectionString: STANDALONE_URL,
    });
    try {
      await client.mongoInsertOne("m0_standalone", { _id: 1 });
      expect(await client.mongoCount("m0_standalone", {})).toBe(1);
      await client.mongoDeleteMany("m0_standalone", {});
    } finally {
      await client.close();
    }
  });
});
