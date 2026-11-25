import type { AppDb } from '../database/database';
import { createDatabaseAccess } from '../database/DatabaseAccess';

test('restore access gate drains an in-flight transaction and rejects competing app writes without queuing them', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const writes: string[] = [];
  const raw = {
    withExclusiveTransactionAsync: async () => { await pending; writes.push('existing committed'); },
    runAsync: async (sql: string) => { writes.push(sql); },
  } as unknown as AppDb;
  const access = createDatabaseAccess(raw);
  const app = access.handle();
  const inFlight = app.withExclusiveTransactionAsync(async () => {});
  let drained = false;
  const pausing = access.pause().then((lease) => { drained = true; return lease; });
  await expect(app.runAsync('competing')).rejects.toThrow('being restored');
  expect(drained).toBe(false);
  finish();
  await inFlight;
  const lease = await pausing;
  expect(writes).toEqual(['existing committed']);
  await expect(app.runAsync('during restore')).rejects.toThrow('being restored');
  lease.release(true);
  await expect(app.runAsync('stale confirmation after commit')).rejects.toThrow('Reopen');
  await access.handle().runAsync('fresh screen');
  expect(writes).toEqual(['existing committed', 'fresh screen']);
});

test('failed restore can resume original handles; duplicate restores are rejected', async () => {
  const runAsync = jest.fn().mockResolvedValue({ changes: 1 });
  const access = createDatabaseAccess({ runAsync } as unknown as AppDb);
  const app = access.handle();
  const lease = await access.pause();
  await expect(access.pause()).rejects.toThrow('already in progress');
  await expect(app.runAsync('blocked')).rejects.toThrow('being restored');
  lease.release(false);
  await app.runAsync('retry after rollback');
  expect(runAsync).toHaveBeenCalledTimes(1);
  expect(runAsync).toHaveBeenCalledWith('retry after rollback');
});
