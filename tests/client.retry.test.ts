import { describe, it, expect } from "vitest";
import { DBClient } from "../client";
import { DBType } from "../types";
import type { Logger } from "../logger";
import type { PoolMetrics } from "../types";

/**
 * `DBClient.query()` retried every failed statement. Every write in the ORM
 * goes through it, so a statement that failed *after* the database committed —
 * a dropped connection on the way back, say — would be retried and applied a
 * second time. Retries are now limited to statements that cannot write.
 */

/** Counts the errors a client logs, one per failed attempt. */
class RecordingLogger implements Logger {
  public errors: string[] = [];

  logQuery(): void {}
  logError(error: Error): void {
    this.errors.push(error.message);
  }
  logMetrics(_metrics: PoolMetrics): void {}
  logInfo(): void {}
  logWarn(): void {}
  logDebug(): void {}
}

function makeClient(): { client: DBClient; logger: RecordingLogger } {
  const logger = new RecordingLogger();
  const client = new DBClient(
    {
      type: DBType.SQLite,
      connectionString: ":memory:",
      // The real backoff is 1s, which would make this file take ten seconds.
      // Only the attempt count is under test.
      retryDelay: 1,
      maxJitter: 0,
    },
    logger,
  );
  return { client, logger };
}

describe("query retry policy", () => {
  it("retries a failed read", async () => {
    const { client, logger } = makeClient();

    await expect(client.query("SELECT * FROM missing_table")).rejects.toThrow();
    // One log per attempt proves the statement was replayed.
    expect(logger.errors).toHaveLength(3);

    await client.close();
  });

  it("does not retry a failed write", async () => {
    const { client, logger } = makeClient();
    await client.query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");

    // A write that fails must be attempted exactly once: replaying it could
    // apply the change twice.
    await expect(
      client.query("INSERT INTO items (nope) VALUES (?)", ["x"]),
    ).rejects.toThrow();
    expect(logger.errors).toHaveLength(1);

    await client.close();
  });

  it("still retries a read behind a leading comment", async () => {
    const { client, logger } = makeClient();

    await expect(
      client.query("/* pool hint */ SELECT * FROM missing_table"),
    ).rejects.toThrow();
    expect(logger.errors).toHaveLength(3);

    await client.close();
  });

  it("does not mistake a longer keyword for a read", async () => {
    const { client, logger } = makeClient();

    // `SELECTED` is not `SELECT`; it must not be treated as a replayable read.
    await expect(client.query("SELECTED nonsense")).rejects.toThrow();
    expect(logger.errors).toHaveLength(1);

    await client.close();
  });
});
