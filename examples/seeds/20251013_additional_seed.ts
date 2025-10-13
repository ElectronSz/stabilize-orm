import { Stabilize } from '../../src';
import { Role } from '../models/Role';

export const dependencies = ['20251013_initial_seed'];

export async function seed(orm: Stabilize) {
  const repo = orm.getRepository(Role);
  await repo.bulkCreate([
    { name: 'Admin' },
    { name: 'User' },
  ], { batchSize: 100 });

  await orm['client'].query(
    `INSERT INTO seed_history (name, applied_at) VALUES (?, ?)`,
    ['20251013_additional_seed', new Date().toISOString()]
  );
}

export async function rollback(orm: Stabilize) {
  const repo = orm.getRepository(Role);
  const entities = await repo.find().execute(orm['client']);
  await repo.bulkDelete(entities.map(e => e.id!), { batchSize: 100 });

  await orm['client'].query(
    `DELETE FROM seed_history WHERE name = ?`,
    ['20251013_additional_seed']
  );
}