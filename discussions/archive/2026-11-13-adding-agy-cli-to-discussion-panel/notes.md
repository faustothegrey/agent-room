# Adding agy CLI to the discussion panel

**Status (2026-11-13): done.** Slices 1–3 and fixes (`4ae24be`…`fc92f87`) tested live by the
User and merged into `main`; `npm test` 214 passing.

Background: branch `adding-agy` holds an analysis (`docs/adding-agy.md`) and Mermaid diagrams;
no implementation.

## Decided (by the User)
- agy becomes a third provider for discussion agents and for the worker.
- Members are chosen **per discussion or brainstorm**, in the panel where the model is chosen:
  two or three, never one or none. Panel as drawn in `drawings/members-panel.svg` (tick box,
  provider selector, editable automatic name such as "Claude2", model, on each row).
- Agents speak in row order (for now). The same provider may appear twice, with distinct names.
- agy gets a quota gauge, as Claude and Codex have.
- A worker change applies **only to the discussion where it is made** (today it applies to every
  open discussion in the folder: `src/ui.mjs:125`, `README.md:229`).

- A worker change also becomes the default for new discussions only when made before work
  starts in that discussion; after that it changes only that discussion.
- Discussions with 1 or more than 3 agents stay possible (set outside the panel, e.g.
  `--agents`); the panel then shows today's rows without tick boxes and explains why.
- agy login shows as "not monitored" (no login command; private login files not read).
- agy gets the rulebook on a session's first turn and again only when it changes
  (tested basis: `agy-checks.md`).
- Three slices, in order: (1) agy provider, gauge, login, token counts; (2) per-discussion
  worker; (3) members panel with per-discussion members, sessions and checkpoints.

## Findings
- **Quota meter already reports agy** (tested 2026-11-13, Claude): `GET :9899/usage` has an
  `antigravity` block (not `agy`), with `parsed.models[]` entries carrying `window` ("5h",
  "weekly") and `used_percent`. `src/usage.mjs:41-43` maps only `claude` and `codex` today.
- agy 1.5.8 is installed; in the User's shell `agy` is an alias adding
  `--dangerously-skip-permissions` (tested). agent-room spawns the binary, not the alias.
- From the branch analysis (not re-tested): resume via `--conversation <id>`; no inline
  system-prompt flag (use `--agent <name>` files or prefix the first prompt); loads `AGENTS.md`/
  `GEMINI.md` automatically; no login-status subcommand (`agy --help` shows none: tested);
  ~13k input tokens and 5–8 s overhead per turn.
- Agent names allow only letters, digits, `_`, `-` (`src/ui.mjs:85`); sessions are keyed by name.

## Open questions
- Delete the test leftovers named in `agy-checks.md`?
