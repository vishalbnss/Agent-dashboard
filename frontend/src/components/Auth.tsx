import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type User } from "../api";
import { Dialog, Icon, LoadingState } from "./ui";

/* Who is signed in. user is null when sign-in is off (local use): then everything is editable. */
type AuthState = { user: User | null; readOnly: boolean; signOut: () => void; changePassword: () => void };
const AuthContext = createContext<AuthState>({ user: null, readOnly: false, signOut: () => {}, changePassword: () => {} });
export const useAuth = () => useContext(AuthContext);

/* The server's {"detail": "..."} message from an api error, or a fallback. */
export function apiMessage(reason: unknown, fallback: string) {
  const text = reason instanceof Error ? reason.message.replace(/^\d+ /, "") : "";
  try { return (JSON.parse(text) as { detail?: string }).detail || fallback; } catch { return fallback; }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ auth: boolean; user: User | null } | null>(null);
  const [changing, setChanging] = useState(false);
  const check = useCallback(() => { api.me().then(setState).catch(() => setState({ auth: false, user: null })); }, []);
  useEffect(() => {
    check();
    addEventListener("auth-required", check);  // any API call answered 401: the session ended
    return () => removeEventListener("auth-required", check);
  }, [check]);
  if (!state) return <LoadingState />;
  const signedIn = (user: User) => setState({ auth: true, user });
  const signOut = () => { void api.logout().finally(() => { location.hash = "#/"; setState({ auth: true, user: null }); }); };
  if (state.auth && !state.user) return <LoginPage onSignedIn={signedIn} />;
  if (state.user?.must_change_password) return <main className="login-page">
    <section className="panel login-card" aria-labelledby="set-password-title">
      <span className="brand"><span className="brand-mark"><Icon name="branch" /></span><span>Agents Dashboard</span></span>
      <h1 id="set-password-title">Set a new password</h1>
      <p className="form-hint">Welcome, {state.user.name}. You signed in with a temporary password from your admin. Choose your own to continue.</p>
      <PasswordForm temporary onDone={signedIn} />
      <button type="button" className="link" onClick={signOut}>Sign out</button>
    </section>
  </main>;
  return <AuthContext.Provider value={{ user: state.user, readOnly: state.user?.role === "admin", signOut, changePassword: () => setChanging(true) }}>
    {children}
    {changing && <Dialog title="Change password" className="dialog-sm" onClose={() => setChanging(false)}>
      <PasswordForm onDone={(user) => { signedIn(user); setChanging(false); }} onCancel={() => setChanging(false)} />
    </Dialog>}
  </AuthContext.Provider>;
}

function PasswordForm({ temporary = false, onDone, onCancel }: { temporary?: boolean; onDone: (user: User) => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) { setErr("Use at least 8 characters."); return; }
    if (next !== confirm) { setErr("The new passwords do not match."); return; }
    setBusy(true); setErr("");
    try { onDone((await api.changePassword(current, next)).user); }
    catch (reason) { setErr(apiMessage(reason, "Could not change the password. Try again.")); }
    finally { setBusy(false); }
  };
  return <form className="password-form" onSubmit={submit} aria-label={temporary ? "Set a new password" : "Change password"}>
    <label className="field"><span>{temporary ? "Temporary password" : "Current password"}</span><input type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required disabled={busy} /></label>
    <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required disabled={busy} aria-describedby="new-password-hint" /></label>
    <p id="new-password-hint" className="form-hint">At least 8 characters.</p>
    <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required disabled={busy} /></label>
    {err && <p className="err" role="alert">{err}</p>}
    <div className="dialog-actions">
      {onCancel && <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>}
      <button type="submit" disabled={busy}>{busy ? "Saving…" : temporary ? "Set password" : "Change password"}</button>
    </div>
  </form>;
}

function LoginPage({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { onSignedIn((await api.login(username, password)).user!); }
    catch (reason) { setErr(reason instanceof Error && reason.message.startsWith("401") ? "Wrong user name or password." : "Could not sign in. Try again."); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <form className="panel login-card" onSubmit={submit} aria-label="Sign in">
      <span className="brand"><span className="brand-mark"><Icon name="branch" /></span><span>Agents Dashboard</span></span>
      <h1>Sign in</h1>
      <label className="field"><span>User name</span><input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required disabled={busy} /></label>
      <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy} /></label>
      {err && <p className="err" role="alert">{err}</p>}
      <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="form-hint login-foot">Forgot your password? Ask your dashboard admin for a temporary one.</p>
    </form>
  </main>;
}
