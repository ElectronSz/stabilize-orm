import { Stabilize } from "../../";
import { User } from "../models/User";

export const dependencies: string[] = [];

export async function seed(orm: Stabilize): Promise<void> {
  const repo = orm.getRepository(User);
  await repo.bulkCreate([
  {
    "id": 1,
    "username": "data_0",
    "fname": "data",
    "lname": "data",
    "active": false
  },
  {
    "id": 2,
    "username": "data_1",
    "fname": "data",
    "lname": "data",
    "active": true
  }
]);
}

export async function rollback(orm: Stabilize): Promise<void> {
  await orm.client.query(`DELETE FROM users WHERE id = ?`, [1]);
  await orm.client.query(`DELETE FROM users WHERE id = ?`, [2]);
}
