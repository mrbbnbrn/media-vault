import type { ReactNode } from 'react';
import { LockIcon, OfflineIcon, WarnIcon } from './Icons';

export function TopBar({ children, title }: { children?: ReactNode; title?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand">
        <LockIcon />
        <span>Media Vault</span>
      </div>
      {title && <span className="faint" style={{ marginLeft: 8 }}>{title}</span>}
      <div className="spacer" />
      {children}
    </header>
  );
}

export function OfflineFooter() {
  return (
    <footer className="footer">
      <OfflineIcon />
      Works fully offline. Nothing is ever sent anywhere.
    </footer>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <WarnIcon size={16} />
      <span>{error}</span>
    </div>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <span className="row" style={{ gap: 10 }}>
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Password + confirmation pair with the shared rules. */
export function PasswordPair(props: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  min: number;
  autoFocus?: boolean;
  label?: string;
}) {
  const { password, confirm, min } = props;
  const short = password.length > 0 && [...password].length < min;
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <>
      <div className="field">
        <label htmlFor="pw1">{props.label ?? 'Password'}</label>
        <input id="pw1" className="input" type="password" autoComplete="new-password" autoFocus={props.autoFocus}
          value={password} onChange={(e) => props.onPassword(e.target.value)} />
        <span className={short ? 'faint' : 'faint'} style={{ fontSize: 12, color: short ? 'var(--warn)' : undefined }}>
          At least {min} characters. A few unrelated words (“lamp river orbit 42”) are strong and easy to remember.
        </span>
      </div>
      <div className="field">
        <label htmlFor="pw2">Type it again</label>
        <input id="pw2" className="input" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => props.onConfirm(e.target.value)} />
        {mismatch && <span style={{ fontSize: 12, color: 'var(--warn)' }}>The two passwords don't match yet.</span>}
      </div>
    </>
  );
}

export function passwordsOk(pw: string, confirm: string, min: number) {
  return [...pw].length >= min && pw === confirm;
}
