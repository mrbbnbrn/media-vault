import { describe, expect, it } from 'vitest';
import type { SessionInfo, VaultEntry } from './api';
import { autoLocks, canCreate, pickAction, vaultBadge } from './vaultpick';

const vault = (over: Partial<VaultEntry> = {}): VaultEntry => ({
  path: 'D:\\Vaults\\Photos', name: 'Photos', status: 'ready', sizeBytes: 1, passwordless: false, ...over,
});
const session = (hasPassword: boolean): SessionInfo => ({
  path: 'D:\\V', name: 'V', items: 0, folders: 0, needsNewPassword: false, hasPassword, restoredFromBackup: null,
});

describe('vaults without a password', () => {
  it('opens a passwordless vault straight away when clicked, and only chooses the others', () => {
    expect(pickAction(vault({ passwordless: true }))).toBe('open');
    expect(pickAction(vault())).toBe('select');
    expect(pickAction(undefined)).toBe('select');
  });

  it('never opens a vault that is not there', () => {
    expect(pickAction(vault({ passwordless: true, status: 'missing' }))).toBe('select');
    expect(pickAction(vault({ passwordless: true, status: 'notVault' }))).toBe('select');
  });

  it('shows "No password" instead of the lock', () => {
    expect(vaultBadge(vault())).toBe('lock');
    expect(vaultBadge(vault({ passwordless: true }))).toBe('noPassword');
    expect(vaultBadge(vault({ status: 'missing' }))).toBeNull();
  });

  it('only vaults with a password lock by themselves', () => {
    expect(autoLocks(session(true))).toBe(true);
    expect(autoLocks(session(false))).toBe(false);
    expect(autoLocks(null)).toBe(false);
  });

  it('can create a vault without a password once name and place are set', () => {
    const base = { name: 'Photos', parent: 'D:\\Vaults', noPassword: false, passwordOk: false };
    expect(canCreate(base)).toBe(false);
    expect(canCreate({ ...base, passwordOk: true })).toBe(true);
    expect(canCreate({ ...base, noPassword: true })).toBe(true);
    expect(canCreate({ ...base, noPassword: true, name: '  ' })).toBe(false);
    expect(canCreate({ ...base, noPassword: true, parent: null })).toBe(false);
  });
});
