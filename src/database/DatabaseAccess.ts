import type { AppDb } from './database';

/** App-owned connection access. A restore drains existing operations, rejects
 * new operations (never queues stale writes), and can revoke pre-restore handles.
 * Native transaction callbacks keep their original scoped handle until drained.
 */
export function createDatabaseAccess(raw: AppDb) {
  let paused = false;
  let generation = 0;
  const active = new Set<Promise<unknown>>();
  const handle = (): AppDb => {
    const lease = generation;
    return new Proxy(raw, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (paused || lease !== generation) {
            return Promise.reject(new Error('App data is being restored. Reopen this screen before saving.'));
          }
          const operation = Promise.resolve().then(() => value.apply(target, args));
          active.add(operation);
          void operation.finally(() => active.delete(operation)).catch(() => {});
          return operation;
        };
      },
    });
  };
  return {
    handle,
    async pause() {
      if (paused) throw new Error('A data operation is already in progress.');
      paused = true;
      await Promise.allSettled([...active]);
      let released = false;
      return {
        release(revokeOldHandles: boolean) {
          if (released) throw new Error('Database access was already released.');
          if (revokeOldHandles) generation += 1;
          paused = false;
          released = true;
        },
      };
    },
  };
}
