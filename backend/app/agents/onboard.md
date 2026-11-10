# Onboarding: generate AGENTS.md for this repository

Goal: write an `AGENTS.md` at the repo root that lets a coding agent work here without exploring
from scratch, and a 3-line `CLAUDE.md` that says "Read AGENTS.md first" plus the test command.
Then call `save_agents_md(content)` with the full AGENTS.md text so the dashboard has it.

Read, in this order and only as much as needed: README*, package/build files (package.json,
pyproject.toml, requirements*.txt, go.mod, pom.xml, *.csproj, Gemfile, Cargo.toml), the top two
levels of the folder tree, CI config (.github/workflows, .gitlab-ci.yml), test config and folders,
lint/format configs, and `git log --oneline -30` for commit style.

AGENTS.md must contain these sections, each concise and concrete (exact commands, real paths):

1. **Setup** - install dependencies, env vars needed, how to run locally.
2. **Commands** - build, run, test (single test too), lint, format, type-check.
3. **Architecture map** - what lives where, entry points, how data flows, key modules.
4. **Conventions** - naming, file placement, state management, styling approach, error handling,
   logging, commit message style, branch naming if visible.
5. **How to add a feature end to end** - one worked example referencing real files.
6. **Do not touch** - generated files, vendored code, migration rules, anything risky.
7. **Testing approach** - framework, where tests live, fixtures/mocks pattern.


Accuracy rules, because later agents act on this file without re-checking:
- Name a dependency, test framework or tool only if it appears in the manifest or lock file
  (package.json, requirements, pyproject, go.mod, ...) or you verified it exists on disk. Never
  assume a framework's "usual defaults" are installed; if something is missing, say so and give the
  exact install command.
- Every command you list must exist in the project's scripts or tooling. If no test suite exists,
  write "no tests yet" and the command that would run them once added.
- Prefer "not present" over a guess. A wrong claim here costs every future run.

Keep it under ~250 lines. If the repo already has an AGENTS.md or CLAUDE.md, improve it rather than
replacing it. Do not commit; leave the files for the developer to review.
