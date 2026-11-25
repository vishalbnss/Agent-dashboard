import { useCallback, useState, type FormEvent } from "react";
import { api, type Account } from "../api";
import { usePolling } from "../hooks/usePolling";
import { apiMessage, useAuth } from "./Auth";
import { Dialog, EmptyState, ErrorNotice, Icon, LoadingState, PageHeader } from "./ui";

/* The admin's account management: create accounts and issue temporary passwords. */
export function UsersPage() {
  const { user } = useAuth();
  const fetcher = useCallback(() => api.users(), []);
  const { data, error, reload } = usePolling(fetcher, 15000);
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<{ name: string; password: string; created: boolean } | null>(null);
  const [resetting, setResetting] = useState("");
  const [err, setErr] = useState("");
  if (user?.role !== "admin") return <EmptyState title="Only the admin manages accounts" icon="shield" />;
  const reset = async (name: string) => {
    if (!confirm(`Give ${name} a new temporary password? Their current password stops working and they are signed out.`)) return;
    setResetting(name); setErr("");
    try { setIssued({ name, password: (await api.resetUserPassword(name)).temporary_password, created: false }); reload(); }
    catch (reason) { setErr(apiMessage(reason, "Could not reset the password. Try again.")); }
    finally { setResetting(""); }
  };
  return <>
    <PageHeader title="Users" description="Create accounts for developers. Each one signs in with a temporary password, then sets their own."
      actions={<button onClick={() => setAdding(true)}><Icon name="plus" /> Add user</button>} />
    {error && <ErrorNotice message={error} onRetry={reload} />}
    {err && <p className="err" role="alert">{err}</p>}
    {!data ? (!error && <LoadingState />) : <div className="table-scroll" role="region" aria-label="Accounts" tabIndex={0}>
      <table className="runs">
        <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Created by</th><th aria-label="Actions"></th></tr></thead>
        <tbody>{data.map((a: Account) => <tr key={a.name}>
          <td><strong>{a.name}</strong>{a.name === user.name && <span className="muted"> (you)</span>}</td>
          <td><span className={`tag ${a.role === "admin" ? "warn" : ""}`}>{a.role === "admin" ? "Admin" : "Developer"}</span></td>
          <td>{a.must_change_password ? <span className="tag warn">Temporary password</span> : <span className="tag ok">Active</span>}</td>
          <td>{a.source === "env" ? <span className="muted">Server settings</span> : a.created_by || "–"}</td>
          <td>{a.name !== user.name && <button className="link" disabled={!!resetting} onClick={() => reset(a.name)}>{resetting === a.name ? "Resetting…" : "Reset password"}</button>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {adding && <AddUserDialog onClose={() => setAdding(false)} onCreated={(name, password) => { setAdding(false); setIssued({ name, password, created: true }); reload(); }} />}
    {issued && <Dialog title={issued.created ? `${issued.name} can sign in` : `New password for ${issued.name}`} onClose={() => setIssued(null)}>
      <p>Send {issued.name} this temporary password. They will be asked to choose their own the first time they sign in.</p>
      <div className="setup-cmd"><code aria-label="Temporary password">{issued.password}</code><CopyText text={issued.password} /></div>
      <p className="form-hint">It is shown only once. If it is lost, use Reset password to issue another.</p>
      <div className="dialog-actions"><button onClick={() => setIssued(null)}>Done</button></div>
    </Dialog>}
  </>;
}

function AddUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, password: string) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("developer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(clean)) { setErr("Use 2–32 lower-case letters, digits, '.', '_' or '-'."); return; }
    setBusy(true); setErr("");
    try { const made = await api.createUser(clean, role); onCreated(made.name, made.temporary_password); }
    catch (reason) { setErr(apiMessage(reason, "Could not create the user. Try again.")); }
    finally { setBusy(false); }
  };
  return <Dialog title="Add user" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <label className="field">User name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={32} placeholder="priya" autoComplete="off" disabled={busy} /></label>
      <label className="field">Role<select value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}><option value="developer">Developer: sees and changes only their own projects</option><option value="admin">Admin: reads every project and manages accounts</option></select></label>
      <p className="form-hint">The dashboard creates a temporary password for you to send them.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Creating…" : "Create user"}</button></div>
    </form>
  </Dialog>;
}

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button className="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>{done ? "Copied" : "Copy"}</button>;
}
