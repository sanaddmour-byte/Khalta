import { assertFourEyes, schema } from '@khalta/db';
import { FourEyesViolation } from '@khalta/rbac';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

// `plants` stands in for any authored record (designs arrive in M4.1): the guard is generic.
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

const target = { table: schema.plants, id: schema.plants.id, createdBy: schema.plants.createdBy };

describe('four-eyes guard', () => {
  it('blocks the persisted author and allows a different actor', async () => {
    const author = await env.seedUser('qc_manager');
    const other = await env.seedUser('qc_manager');
    const plant = await env.seedPlant('FE-1', author.id);
    await env.db.transaction(async (tx) => {
      await expect(assertFourEyes(tx, target, plant.id, author.id)).rejects.toBeInstanceOf(
        FourEyesViolation,
      );
      await expect(assertFourEyes(tx, target, plant.id, other.id)).resolves.toBeUndefined();
    });
  });

  it('blocks records with an unknown author (cannot prove a second pair of eyes)', async () => {
    const actor = await env.seedUser('qc_manager');
    const plant = await env.seedPlant('FE-2', null);
    await env.db.transaction(async (tx) => {
      await expect(assertFourEyes(tx, target, plant.id, actor.id)).rejects.toBeInstanceOf(
        FourEyesViolation,
      );
    });
  });

  it('reads the author from the database, not from anything the caller supplies', async () => {
    const author = await env.seedUser('qc_manager');
    const other = await env.seedUser('qc_manager');
    const plant = await env.seedPlant('FE-3', author.id);
    // Another session re-labels the author after the actor "reviewed" the record.
    await env.db.update(schema.plants).set({ createdBy: other.id }).where(eqId(plant.id));
    await env.db.transaction(async (tx) => {
      await expect(assertFourEyes(tx, target, plant.id, other.id)).rejects.toBeInstanceOf(
        FourEyesViolation,
      );
      await expect(assertFourEyes(tx, target, plant.id, author.id)).resolves.toBeUndefined();
    });
  });

  it('holds a row lock so the author cannot change between check and transition', async () => {
    const author = await env.seedUser('qc_manager');
    const other = await env.seedUser('qc_manager');
    const plant = await env.seedPlant('FE-4', author.id);
    let relabelFinished = false;
    await env.db.transaction(async (tx) => {
      await assertFourEyes(tx, target, plant.id, other.id);
      const racing = env.db
        .update(schema.plants)
        .set({ createdBy: other.id })
        .where(eqId(plant.id))
        .then(() => (relabelFinished = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(relabelFinished).toBe(false); // blocked by our lock until we commit
      void racing;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(relabelFinished).toBe(true);
  });

  it('fails loudly for a missing record', async () => {
    const actor = await env.seedUser('qc_manager');
    await env.db.transaction(async (tx) => {
      await expect(
        assertFourEyes(tx, target, '00000000-0000-4000-8000-0000000000ee', actor.id),
      ).rejects.toThrow(/not found/);
    });
  });
});

import { eq } from 'drizzle-orm';
function eqId(id: string) {
  return eq(schema.plants.id, id);
}
