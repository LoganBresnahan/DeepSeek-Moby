import * as fs from 'fs';

import { Database } from './SqlJsWrapper';

/**
 * SQLite minimum page size is 512B; default is 4096B. A file smaller than
 * one page cannot structurally hold user data, so it's safe to discard.
 * Files larger than this may contain real conversation history that the
 * user wants back via key recovery, so we refuse to auto-destroy them.
 */
export const MAX_QUARANTINE_BYTES = 4096;

/**
 * Open the SQLCipher database, recovering from a corrupt or key-mismatched
 * file ONLY when the file is clearly garbage from a partial init (≤4KB).
 * Larger files likely contain real conversation history and must never be
 * silently destroyed — we throw with a recovery hint pointing the user at
 * the `Moby: Manage Database Encryption Key` command instead.
 *
 * Reproduced on a clean M1 Mac install: extension crashed during first
 * activation after creating an empty `moby.db`, leaving a zero/garbage
 * file. Subsequent activations hit `SQLITE_NOTADB: file is not a database`
 * because the encryption key (newly generated, fine) couldn't decrypt the
 * partial file. The auto-recovery path here resolves that case.
 *
 * Real-history risk case (Keychain wipe, key rotation gone wrong, etc.):
 * file is >4KB, so we throw rather than nuking it.
 */
export function openDbWithRecovery(dbPath: string, encryptionKey?: string): Database {
  try {
    return new Database(dbPath, encryptionKey);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isNotADb = /SQLITE_NOTADB|file is not a database/i.test(msg);
    if (!isNotADb || dbPath === ':memory:') throw e;

    // Inspect file size before deciding what to do. Stat failures fall
    // through to the rethrow — better to surface the real error than guess.
    let fileSize = 0;
    try {
      fileSize = fs.statSync(dbPath).size;
    } catch {
      throw e;
    }

    if (fileSize > MAX_QUARANTINE_BYTES) {
      throw new Error(
        `Database file at ${dbPath} cannot be decrypted (${msg}). ` +
        `File size is ${fileSize} bytes — too large to auto-discard, may contain conversation history. ` +
        `Run "Moby: Manage Database Encryption Key" to restore the key, or back up and delete the file manually to start fresh.`
      );
    }

    const quarantine = `${dbPath}.broken-${Date.now()}`;
    try {
      fs.renameSync(dbPath, quarantine);
    } catch (renameErr) {
      const renameMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
      throw new Error(
        `Database file is corrupt (${msg}). Tried to quarantine to ${quarantine} but rename failed: ${renameMsg}`
      );
    }

    return new Database(dbPath, encryptionKey);
  }
}
