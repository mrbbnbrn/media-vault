// Vaults without a password: what the vault list and settings do with them.

import type { SessionInfo, VaultEntry } from './api';

/** Plain warning shown wherever a vault is made, or switched, to have no password. */
export const NO_PASSWORD_WARNING = 'Anyone who has the vault folder can open it — no password needed.';

/**
 * Clicking a vault in the list: one without a password opens straight away;
 * any other is just chosen (then its password is asked for). Choosing a vault
 * by itself (when the app starts, after locking) never opens it.
 */
export function pickAction(v: VaultEntry | undefined): 'open' | 'select' {
  return v?.status === 'ready' && v.passwordless ? 'open' : 'select';
}

/** What the vault list shows beside a vault: a lock, a "No password" label, or nothing (not available). */
export function vaultBadge(v: VaultEntry): 'lock' | 'noPassword' | 'notEncrypted' | null {
  if (v.status !== 'ready') return null;
  if (v.encrypted === false) return 'notEncrypted';
  return v.passwordless ? 'noPassword' : 'lock';
}

/** Does the open vault lock by itself? A vault without a password never does. */
export function autoLocks(s: SessionInfo | null | undefined): boolean {
  return !!s && s.hasPassword !== false;
}

/** Create-vault form: enough filled in to create? */
export function canCreate(f: { name: string; parent: string | null; noPassword: boolean; passwordOk: boolean }): boolean {
  return f.name.trim().length > 0 && !!f.parent && (f.noPassword || f.passwordOk);
}
