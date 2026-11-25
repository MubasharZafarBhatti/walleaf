import { coordinateRestore } from '../services/backup/RestoreCoordinator';

test('refresh and notifications run only after commit and lease revocation', async () => {
  const order: string[] = [];
  const result = await coordinateRestore({
    pause: async () => { order.push('pause'); return { release: (revoke) => { order.push(`release:${revoke}`); } }; },
    write: async () => { order.push('commit'); },
    refresh: async () => { order.push('refresh'); },
    reconcile: async () => { order.push('notify'); return true; },
  });
  expect(order).toEqual(['pause', 'commit', 'release:true', 'refresh', 'notify']);
  expect(result).toEqual({ committed: true, refreshFailed: false, notificationsFailed: false });
});

test('rollback resumes original access and performs no post-commit effects', async () => {
  const release = jest.fn();
  const refresh = jest.fn();
  const reconcile = jest.fn();
  await expect(coordinateRestore({ pause: async () => ({ release }), write: async () => { throw new Error('rollback'); }, refresh, reconcile })).rejects.toThrow('rollback');
  expect(release).toHaveBeenCalledWith(false);
  expect(refresh).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
});

test.each(['refresh', 'notification exception', 'notification failure'])('%s cannot repeat or roll back a committed restore', async (failure) => {
  const write = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn();
  const result = await coordinateRestore({
    pause: async () => ({ release }), write,
    refresh: async () => { if (failure === 'refresh') throw new Error('read failed'); },
    reconcile: async () => { if (failure === 'notification exception') throw new Error('OS failure'); return failure !== 'notification failure'; },
  });
  expect(result.committed).toBe(true);
  expect(result.refreshFailed).toBe(failure === 'refresh');
  expect(result.notificationsFailed).toBe(failure !== 'refresh');
  expect(write).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledWith(true);
});
