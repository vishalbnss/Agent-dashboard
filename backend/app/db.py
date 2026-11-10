"""SQLModel models + engine. SQLite by default, Postgres via DATABASE_URL."""
import json
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Field, Session, SQLModel, create_engine, select

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DATABASE_URL = re.sub(r"^postgres(ql)?://", "postgresql+psycopg://",  # Render and Heroku hand out postgres:// URLs
                      os.getenv("DATABASE_URL") or f"sqlite:///{DATA_DIR / 'app.db'}")
engine = (create_engine(DATABASE_URL, connect_args={"check_same_thread": False}) if DATABASE_URL.startswith("sqlite")
          else create_engine(DATABASE_URL, pool_pre_ping=True))  # hosted Postgres drops idle connections

DEFAULT_CAPS: dict = {}  # fix-loop limits now live in the workflow prompts


def now() -> datetime:
    return datetime.now(timezone.utc)


def is_url(s: str) -> bool:
    return bool(re.match(r"^(https?://|git@|ssh://)", s.strip()))


def normalize_repo_url(url: str) -> str:
    """git@github.com:Org/Repo.git -> https://github.com/org/repo. Empty stays empty."""
    u = url.strip()
    if not u:
        return ""
    m = re.match(r"^git@([^:]+):(.+)$", u)
    if m:
        u = f"https://{m.group(1)}/{m.group(2)}"
    u = re.sub(r"\.git$", "", u.rstrip("/"))
    u = re.sub(r"^https?://", "https://", u)
    return u.lower()


def normalize_path(path: str) -> str:
    """Local folder: absolute, forward slashes, no trailing slash, case-folded (Windows is case-insensitive)."""
    p = path.strip().strip('"').replace("\\", "/").rstrip("/")
    return p.lower() if p else ""


def split_location(location: str) -> tuple[str, str]:
    """A user-entered location is either a repo URL or a local folder path. Returns (repo_url, local_path)."""
    return (normalize_repo_url(location), "") if is_url(location) else ("", normalize_path(location))


class Project(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    key: str = Field(default_factory=lambda: secrets.token_urlsafe(24), index=True)  # secret in the connect URL
    repo_url: str = Field(default="", index=True)    # GitHub URL, optional; needed only for pull requests
    local_path: str = Field(default="", index=True)  # folder as reported by the developer's AI (informational)
    agents_md: str = ""
    caps_json: str = json.dumps(DEFAULT_CAPS)
    ai: str = ""                  # "" | claude | codex | copilot
    connected_at: datetime | None = None  # last time any AI connected to our MCP with ?project=<id>
    claude_connected_at: datetime | None = None  # per-AI, so the dashboard can show one box each
    codex_connected_at: datetime | None = None
    copilot_connected_at: datetime | None = None
    setup_complete: bool = False          # the onboarding wizard has been finished (or its optional steps skipped)
    onboarding_status: str = ""   # "" | running | done | failed | skipped
    onboarding_stage: str = ""    # starting | reading | preparing | writing | done
    onboarding_log: str = ""
    created_at: datetime = Field(default_factory=now)

    @property
    def caps(self) -> dict:
        return {**DEFAULT_CAPS, **json.loads(self.caps_json or "{}")}


class Integration(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    kind: str  # figma | github | jira
    config_json: str = "{}"
    secret_enc: str = ""


class AppRegistration(SQLModel, table=True):
    """Our dashboard's own client id at a provider's MCP server (Figma, Jira), obtained by dynamic registration."""
    id: int | None = Field(default=None, primary_key=True)
    provider: str = Field(index=True)   # figma | jira
    client_id: str = ""
    client_secret_enc: str = ""
    redirect_uri: str = ""
    metadata_json: str = "{}"           # the provider's OAuth endpoints
    created_at: datetime = Field(default_factory=now)


class Ticket(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    key: str = Field(index=True)
    title: str = ""
    body_md: str = ""
    source: str = "pasted"
    created_at: datetime = Field(default_factory=now)


class Run(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    goal: str
    title: str = ""           # short line for lists, written by the AI (falls back to the first sentence of goal)
    number: int = 0           # 1, 2, 3 ... within the project (ids are global)
    client: str = "unknown"
    status: str = "running"  # running | awaiting_approval | done | failed | stopped
    branch: str = ""
    pr_url: str = ""
    usage_json: str = "{}"
    summary_md: str = ""
    started_at: datetime = Field(default_factory=now)
    finished_at: datetime | None = None


class Approval(SQLModel, table=True):
    """One version of a run's design document, waiting for or carrying a human decision made on the dashboard."""
    id: int | None = Field(default=None, primary_key=True)
    run_id: int = Field(foreign_key="run.id", index=True)
    version: int = 1
    content_md: str = ""
    status: str = "pending"        # pending | approved | changes_requested
    decided_by: str = ""
    comment: str = ""
    section_comments_json: str = "{}"   # {"Risks": "add mobile", ...}: notes the reviewer left on document sections
    created_at: datetime = Field(default_factory=now)
    decided_at: datetime | None = None

    def view(self) -> dict:
        return {**self.model_dump(exclude={"section_comments_json"}), "section_comments": json.loads(self.section_comments_json or "{}")}


class RunPhase(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    run_id: int = Field(foreign_key="run.id", index=True)
    name: str
    status: str = "done"
    notes: str = ""
    model: str = ""                  # effective model the agent reported on completion
    tokens: int | None = None        # the agent's cumulative total tokens so far, as the harness printed them
    duration_ms: int | None = None   # the agent's cumulative working time so far, as the harness printed it
    ts: datetime = Field(default_factory=now)


class LogEntry(SQLModel, table=True):
    """One line in a project's Logs tab: an MCP tool call from the AI or an action on the dashboard."""
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    run_id: int | None = Field(default=None, index=True)
    ts: datetime = Field(default_factory=now, index=True)
    level: str = "info"       # debug | info | warn | error
    source: str = "mcp"       # mcp (the AI called a tool) | dashboard (someone used the UI) | system
    event: str = ""           # tool name, or e.g. approval.decided
    client: str = ""          # claude | codex | copilot
    message: str = ""
    detail_json: str = "{}"   # trimmed arguments and result
    duration_ms: int | None = None


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    _add_missing_columns()
    with Session(engine) as s:  # projects created before keys existed get one now
        for p in s.exec(select(Project).where((Project.key == None) | (Project.key == ""))).all():  # noqa: E711
            p.key = secrets.token_urlsafe(24)
            s.add(p)
        # runs created before per-project numbering get their number from creation order
        for pid in {r.project_id for r in s.exec(select(Run).where(Run.number == 0)).all()}:
            runs = s.exec(select(Run).where(Run.project_id == pid).order_by(Run.started_at, Run.id)).all()
            for n, r in enumerate(runs, 1):
                r.number = n
                s.add(r)
        s.commit()


def _add_missing_columns() -> None:
    """Tiny forward-only migration: add columns that exist on the models but not yet in SQLite.
    ponytail: enough for a dev DB; use Alembic when there is a shared Postgres."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in have:
                    typ = col.type.compile(engine.dialect)
                    default = "" if col.default is None or callable(col.default.arg) else f" DEFAULT {col.default.arg!r}"
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {typ}{default}'))


def get_session():
    with Session(engine) as s:
        yield s


def find_project(s: Session, repo_url: str = "", local_path: str = "") -> Project | None:
    """Match by remote URL first, then by local folder. Either may be empty."""
    url, path = normalize_repo_url(repo_url), normalize_path(local_path)
    if url and (p := s.exec(select(Project).where(Project.repo_url == url)).first()):
        return p
    if path:
        return s.exec(select(Project).where(Project.local_path == path)).first()
    return None
