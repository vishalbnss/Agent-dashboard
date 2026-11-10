import { useState, type FormEvent } from "react";
import { api, type Ticket } from "../api";
import { Dialog, EmptyState, Icon } from "./ui";

function TicketEditor({ projectId, ticket, tickets, onClose, onSaved }: {
  projectId: number; ticket: Ticket | null; tickets: Ticket[]; onClose: () => void; onSaved: () => void;
}) {
  const [key, setKey] = useState(ticket?.key ?? "");
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [body, setBody] = useState(ticket?.body_md ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const close = () => { if (!saving) onClose(); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedKey = key.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(normalizedKey)) { setError("Use a ticket ID such as FIN-2."); return; }
    if (!title.trim() || !body.trim()) { setError("Enter a title and ticket details."); return; }
    if (!ticket && tickets.some((existing) => existing.key === normalizedKey)) {
      setError("A ticket with this ID already exists. Edit that ticket instead."); return;
    }
    setSaving(true); setError("");
    try {
      await (ticket ? api.putTicket : api.createTicket)(projectId, normalizedKey, title.trim(), body.trim());
      onSaved(); onClose();
    } catch (reason) {
      setError(String(reason).includes("409") ? "A ticket with this ID already exists. Edit that ticket instead." : "Could not save the ticket. Your draft is still here; try again.");
    } finally { setSaving(false); }
  };
  return <Dialog title={ticket ? `Edit ${ticket.key}` : "Add ticket"} onClose={close}>
    <form onSubmit={save}>
      <label className="field">Ticket ID<input value={key} onChange={(e) => setKey(e.target.value)} readOnly={!!ticket} required placeholder="FIN-2" maxLength={64} /></label>
      <label className="field">Title<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
      <label className="field">Ticket details<textarea value={body} onChange={(e) => setBody(e.target.value)} required rows={12} aria-describedby="ticket-details-hint" /></label>
      <p id="ticket-details-hint" className="form-hint">Include requirements, acceptance criteria, and any Figma links.</p>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={close} disabled={saving}>Cancel</button><button type="submit" disabled={saving}>{saving ? "Saving…" : "Save ticket"}</button></div>
    </form>
  </Dialog>;
}

export function TicketsTab({ projectId, tickets, onChanged }: { projectId: number; tickets: Ticket[]; onChanged: () => void }) {
  const [editor, setEditor] = useState<{ ticket: Ticket | null } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [error, setError] = useState("");
  const remove = async (ticket: Ticket) => {
    if (!confirm(`Delete ${ticket.key}? Existing runs will remain.`)) return;
    setDeleting(ticket.id); setError("");
    try { await api.deleteTicket(projectId, ticket.key); onChanged(); }
    catch { setError("Could not delete the ticket. Try again."); }
    finally { setDeleting(null); }
  };
  const copy = async (ticket: Ticket) => {
    try { await navigator.clipboard.writeText(`Implement ${ticket.key} and review it. Read the ticket from Agents Dashboard.`); setCopied(ticket.id); setError(""); }
    catch { setError(`Could not copy. In your connected AI, type: Implement ${ticket.key} and review it.`); }
  };
  return <section aria-label="Project tickets">
    <div className="section-heading"><div><h2>Tickets</h2><p>Add requirements here, then ask your connected AI to implement the ticket ID.</p></div><button onClick={() => setEditor({ ticket: null })}><Icon name="plus" /> Add ticket</button></div>
    {error && <p className="err" role="alert">{error}</p>}
    {!tickets.length ? <EmptyState title="No tickets yet" icon="document" /> : <div className="ticket-list">
      {tickets.map((ticket) => <article className="ticket-card" key={ticket.id} aria-labelledby={`ticket-title-${ticket.id}`}>
        <div className="ticket-card-heading"><span className="ticket-key">{ticket.key}</span><span className="tag">{ticket.source === "jira" ? "Jira" : "Manual"}</span></div>
        <h3 id={`ticket-title-${ticket.id}`}>{ticket.title || ticket.key}</h3>
        <details className="ticket-details"><summary>View details</summary><div className="ticket-body">{ticket.body_md}</div></details>
        <div className="ticket-actions">
          <button className="secondary" onClick={() => copy(ticket)}>{copied === ticket.id ? "Copied" : "Copy request"}</button>
          {ticket.source !== "jira" && <button className="link" onClick={() => setEditor({ ticket })}>Edit</button>}
          <button className="link" disabled={deleting !== null} onClick={() => remove(ticket)}>{deleting === ticket.id ? "Deleting…" : "Delete"}</button>
        </div>
      </article>)}
    </div>}
    {editor && <TicketEditor projectId={projectId} ticket={editor.ticket} tickets={tickets} onClose={() => setEditor(null)} onSaved={onChanged} />}
  </section>;
}
