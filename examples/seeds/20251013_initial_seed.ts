import { Stabilize } from "../../src";
import { User } from "../models/User";

export const dependencies = [];

export async function seed(orm: Stabilize) {
  const repo = orm.getRepository(User);
  await repo.bulkCreate(
    [
      { name: "Alice", email: "alice@example.com", active: true },
      { name: "Bob", email: "bob@example.com", active: true },
    ],
    { batchSize: 100 },
  );

  await orm["client"].query(
    `INSERT INTO seed_history (name, applied_at) VALUES (?, ?)`,
    ["20251013_initial_seed", new Date().toISOString()],
  );
}

export async function rollback(orm: Stabilize) {
  const repo = orm.getRepository(User);
  const entities = await repo.find().execute(orm["client"]);
  await repo.bulkDelete(
    entities.map((e) => e.id!),
    { batchSize: 100 },
  );

  await orm["client"].query(`DELETE FROM seed_history WHERE name = ?`, [
    "20251013_initial_seed",
  ]);
}
