import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type User } from "../api";
import { Icon, LoadingState } from "./ui";

/* Who is signed in. user is null when sign-in is off (local use): then everything is editable. */
type AuthState = { user: User | null; readOnly: boolean; signOut: () => void };
const AuthContext = createContext<AuthState>({ user: null, readOnly: false, signOut: () => {} });
export const useAuth = () => useContext(AuthContext);

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ auth: boolean; user: User | null } | null>(null);
  const check = useCallback(() => { api.me().then(setState).catch(() => setState({ auth: false, user: null })); }, []);
  useEffect(() => {
    check();
    addEventListener("auth-required", check);  // any API call answered 401: the session ended
    return () => removeEventListener("auth-required", check);
  }, [check]);
  if (!state) return <LoadingState />;
  if (state.auth && !state.user) return <LoginPage onSignedIn={(user) => setState({ auth: true, user })} />;
  const signOut = () => { void api.logout().finally(() => { location.hash = "#/"; setState({ auth: true, user: null }); }); };
  return <AuthContext.Provider value={{ user: state.user, readOnly: state.user?.role === "admin", signOut }}>{children}</AuthContext.Provider>;
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
    </form>
  </main>;
}
