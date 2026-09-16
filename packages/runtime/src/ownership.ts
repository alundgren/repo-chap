import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RuntimeError } from './artifacts.js';

export function claimProcess(db: DatabaseSync): string {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key='daemon_owner'").get();
    if (row) {
      const owner = JSON.parse(String(row.value)) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new RuntimeError('The daemon ownership record is invalid. Inspect private runtime storage.');
      try { process.kill(owner.pid, 0); throw new RuntimeError('A daemon or maintenance command already owns this state directory. Stop the service before backup.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    const token = randomUUID();
    db.prepare("INSERT INTO metadata VALUES ('daemon_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ pid: process.pid, token }));
    db.exec('COMMIT'); return token;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function releaseProcess(db: DatabaseSync, token: string): void {
  db.prepare("DELETE FROM metadata WHERE key='daemon_owner' AND json_extract(value,'$.token')=?").run(token);
}
