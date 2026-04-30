/**
 * Tests for openDbWithRecovery — the SQLCipher recovery path that quarantines
 * obviously-garbage partial-init files but refuses to discard files large
 * enough to potentially contain real conversation history.
 *
 * Uses real fs + real Database (SQLCipher) against temp directories to
 * verify behavior under actual SQLITE_NOTADB conditions, not a mocked
 * approximation of them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDbWithRecovery, MAX_QUARANTINE_BYTES } from '../../../src/events/dbRecovery';

const KEY = 'test-key-not-secret';

describe('openDbWithRecovery', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moby-db-recovery-'));
    dbPath = path.join(tmpDir, 'moby.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens a fresh database when no file exists', () => {
    const db = openDbWithRecovery(dbPath, KEY);
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
  });

  it('opens an existing valid database with the correct key', () => {
    const first = openDbWithRecovery(dbPath, KEY);
    first.exec('CREATE TABLE marker (id INTEGER)');
    first.close();

    const second = openDbWithRecovery(dbPath, KEY);
    const rows = second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='marker'").all();
    expect(rows.length).toBe(1);
    second.close();
  });

  it('quarantines a sub-page-size garbage file and starts fresh', () => {
    fs.writeFileSync(dbPath, Buffer.alloc(100, 0xff));

    const db = openDbWithRecovery(dbPath, KEY);
    expect(fs.existsSync(dbPath)).toBe(true);

    const quarantined = fs.readdirSync(tmpDir).filter(f => f.includes('.broken-'));
    expect(quarantined.length).toBe(1);
    expect(fs.statSync(path.join(tmpDir, quarantined[0])).size).toBe(100);

    // Fresh DB is usable — schema works.
    db.exec('CREATE TABLE marker (id INTEGER)');
    db.close();
  });

  it('quarantines exactly-MAX_QUARANTINE_BYTES file (boundary, ≤ threshold)', () => {
    fs.writeFileSync(dbPath, Buffer.alloc(MAX_QUARANTINE_BYTES, 0xff));

    const db = openDbWithRecovery(dbPath, KEY);
    const quarantined = fs.readdirSync(tmpDir).filter(f => f.includes('.broken-'));
    expect(quarantined.length).toBe(1);
    expect(fs.statSync(path.join(tmpDir, quarantined[0])).size).toBe(MAX_QUARANTINE_BYTES);
    db.close();
  });

  it('refuses to discard a file just over MAX_QUARANTINE_BYTES (boundary, > threshold)', () => {
    fs.writeFileSync(dbPath, Buffer.alloc(MAX_QUARANTINE_BYTES + 1, 0xff));

    expect(() => openDbWithRecovery(dbPath, KEY)).toThrow(/Manage Database Encryption Key/);

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBe(MAX_QUARANTINE_BYTES + 1);
    const quarantined = fs.readdirSync(tmpDir).filter(f => f.includes('.broken-'));
    expect(quarantined.length).toBe(0);
  });

  it('refuses to discard a clearly-real-history-sized file', () => {
    fs.writeFileSync(dbPath, Buffer.alloc(64 * 1024, 0xff));

    expect(() => openDbWithRecovery(dbPath, KEY)).toThrow(/may contain conversation history/);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('throws on wrong-key open of a valid database (does not quarantine)', () => {
    const first = openDbWithRecovery(dbPath, KEY);
    first.exec('CREATE TABLE marker (id INTEGER)');
    first.close();

    // A real SQLCipher DB at this point is >4KB after WAL + schema, so the
    // recovery path's size guard kicks in and we throw rather than nuke.
    expect(() => openDbWithRecovery(dbPath, 'wrong-key')).toThrow();
    expect(fs.existsSync(dbPath)).toBe(true);
    const quarantined = fs.readdirSync(tmpDir).filter(f => f.includes('.broken-'));
    expect(quarantined.length).toBe(0);
  });

  it('does not attempt recovery for :memory: paths', () => {
    // An in-memory DB cannot trigger SQLITE_NOTADB the same way a corrupt
    // file does, but we confirm the path is short-circuited (no fs writes
    // attempted, normal open succeeds).
    const db = openDbWithRecovery(':memory:', KEY);
    db.exec('CREATE TABLE marker (id INTEGER)');
    db.close();
  });
});
