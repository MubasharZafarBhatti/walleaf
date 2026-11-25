/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDb } from '../database/database';
import { changeToken } from '../hooks/useAppData';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const wrap = (database: DatabaseSync) => ({
  getFirstAsync: async (sql: string) => database.prepare(sql).get() ?? null,
}) as unknown as AppDb;

test('the refresh change token moves on writes from this connection and from any other connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-'));
  const main = new DatabaseSync(join(dir, 'a.db'));
  const other = new DatabaseSync(join(dir, 'a.db'));
  try {
    main.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (v INTEGER)');
    const db = wrap(main);
    const first = await changeToken(db);
    expect(first).toEqual(expect.any(String));
    expect(await changeToken(db)).toBe(first); // nothing written: a resume refresh can be skipped
    main.exec('INSERT INTO t VALUES (1)');
    const afterOwn = await changeToken(db);
    expect(afterOwn).not.toBe(first);
    other.exec('INSERT INTO t VALUES (2)'); // e.g. an exclusive transaction on its own connection
    expect(await changeToken(db)).not.toBe(afterOwn);
  } finally { main.close(); other.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable token never skips a reload', async () => {
  expect(await changeToken({ getFirstAsync: async () => { throw new Error('no pragma'); } } as unknown as AppDb)).toBeNull();
});
