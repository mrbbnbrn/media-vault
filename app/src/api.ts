// Typed calls into the Rust backend. When the UI runs in a plain browser
// (design preview, no Tauri), a small in-memory mock answers instead.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

export interface LockSettings {
  idleMinutes: number;
  onSystemLock: boolean;
  onMinimize: boolean;
  safetyNetMinutes: number;
}

export interface AppConfig {
  accent: string;
  lock: LockSettings;
  fullscreenControlsOnMouse: boolean;
  vaults: { path: string }[];
  lastVault: string | null;
}

export interface VaultEntry {
  path: string;
  name: string;
  status: 'ready' | 'missing' | 'notVault';
  sizeBytes: number | null;
}

export interface SessionInfo {
  path: string;
  name: string;
  items: number;
  folders: number;
  needsNewPassword: boolean;
  restoredFromBackup: string | null;
}

export interface AppState {
  config: AppConfig;
  vaults: VaultEntry[];
  session: SessionInfo | null;
  minPasswordChars: number;
}

export type LockReason = 'idle' | 'safetyNet' | 'systemLocked' | 'sleep' | 'minimized' | 'panicKey' | 'manual';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const api = {
  getState: () => call<AppState>('get_state'),
  saveConfig: (config: AppConfig) => call<AppConfig>('save_config', { config }),
  addVault: (path: string) => call<VaultEntry>('add_vault', { path }),
  forgetVault: (path: string) => call<void>('forget_vault', { path }),
  createVault: (parent: string, name: string, password: string) =>
    call<{ session: SessionInfo; words: string[] }>('create_vault', { parent, name, password }),
  unlock: (path: string, password: string) => call<SessionInfo>('unlock', { path, password }),
  unlockWithRecovery: (path: string, words: string) => call<SessionInfo>('unlock_with_recovery', { path, words }),
  setNewPassword: (password: string) => call<SessionInfo>('set_new_password', { password }),
  changePassword: (current: string, password: string) => call<void>('change_password', { current, password }),
  resetRecovery: (current: string) => call<string[]>('reset_recovery', { current }),
  lock: () => call<void>('lock_vault'),
  reportActivity: (kind: 'input' | 'playing') => call<void>('report_activity', { kind }),
};

export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri) return mock.pickFolder();
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === 'string' ? r : null;
}

export async function onLocked(cb: (reason: LockReason) => void): Promise<UnlistenFn> {
  if (!inTauri) {
    mock.lockListeners.push(cb);
    return () => {};
  }
  return listen<LockReason>('vault-locked', (e) => cb(e.payload));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) return mock.call(cmd, args ?? {}) as Promise<T>;
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

// ---- browser-only mock -------------------------------------------------------

const WORDS =
  'harbor lunar ticket pepper oval wisdom gentle forest canyon ribbon atom spray velvet frozen orbit maple shadow guitar remind lens unfair candle drift solar'.split(
    ' ',
  );

const mock = {
  lockListeners: [] as ((r: LockReason) => void)[],
  state: {
    config: {
      accent: '#2ec4b6',
      lock: { idleMinutes: 15, onSystemLock: true, onMinimize: false, safetyNetMinutes: 0 },
      fullscreenControlsOnMouse: true,
      vaults: [{ path: 'D:\\Vaults\\Photos' }, { path: 'D:\\Vaults\\Archive' }, { path: 'F:\\Vault backup' }],
      lastVault: 'D:\\Vaults\\Photos',
    },
    vaults: [
      { path: 'D:\\Vaults\\Photos', name: 'Photos', status: 'ready', sizeBytes: 8.2e9 },
      { path: 'D:\\Vaults\\Archive', name: 'Archive', status: 'ready', sizeBytes: 1.01e11 },
      { path: 'F:\\Vault backup', name: 'Vault backup', status: 'missing', sizeBytes: null },
    ],
    session: null,
    minPasswordChars: 8,
  } as AppState,
  pickFolder: async () => 'D:\\Vaults',
  async call(cmd: string, a: Record<string, unknown>): Promise<unknown> {
    await new Promise((r) => setTimeout(r, cmd.startsWith('unlock') || cmd === 'create_vault' ? 600 : 50));
    const s = this.state;
    const session = (path: string, needsNewPassword = false): SessionInfo => ({
      path,
      name: path.split('\\').pop() ?? path,
      items: 0,
      folders: 0,
      needsNewPassword,
      restoredFromBackup: null,
    });
    switch (cmd) {
      case 'get_state':
        return structuredClone(s);
      case 'save_config':
        s.config = { ...(a.config as AppConfig), vaults: s.config.vaults, lastVault: s.config.lastVault };
        return s.config;
      case 'unlock':
        if (a.password !== 'password') throw new Error("That password doesn't match this vault. (Preview: use “password”.)");
        return (s.session = session(a.path as string));
      case 'unlock_with_recovery':
        return (s.session = session(a.path as string, true));
      case 'set_new_password':
        s.session = { ...s.session!, needsNewPassword: false };
        return s.session;
      case 'create_vault': {
        const path = `${a.parent}\\${a.name}`;
        s.vaults.push({ path, name: a.name as string, status: 'ready', sizeBytes: 4096 });
        return { session: (s.session = session(path)), words: WORDS };
      }
      case 'reset_recovery':
        return WORDS;
      case 'lock_vault':
        s.session = null;
        this.lockListeners.forEach((l) => l('manual'));
        return;
      case 'forget_vault':
        s.vaults = s.vaults.filter((v) => v.path !== a.path);
        return;
      case 'add_vault':
        throw new Error('Preview: adding vaults works in the real app.');
      default:
        return;
    }
  },
};
