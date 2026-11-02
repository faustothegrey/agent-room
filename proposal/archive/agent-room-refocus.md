# Worker brief: refocus agent-room's documentation

> **Historical archive — 2026-11-02.** The documentation refocus is complete; the work order below is historical. Earlier status labels and next steps below describe the original discussion, not current work. See [the proposal index](../README.md).

**Status: drafted by Claude and Codex, 2026-10-20. The User approved the goal sentence (§1)
and the file list (§4) on 2026-10-20.**

## 1. Goal (drafted by Codex; approved by the User 2026-10-20: "perfect")
"Agent-room helps a human and multiple AI agents discuss and revise ideas around a shared
document or drawing, keeping the conversation and its subject visible together."

Longer-term purpose, unchanged: build educational software for maths and science by
vibecoding, keeping costs under control (from `README-for-brainstorming-agents.md`).

## 2. Three kinds of statement (keep them apart in every file)
- **Today (documented behaviour):** terminal room with turn-taking agents; `/docs` shows a
  `proposal/` file in the browser and reloads it when it changes; `/usage`; `/reload`.
- **First implementation cycle (User's direction, 2026-10-20):** chat between the User and
  the agents on the left, the chosen Markdown or SVG document on the right. Nothing else.
  See `discussion-ide.md`.
- **Future possibilities (not planned):** live preview, pointing at animations, DiagramTalk,
  remote attach. Mention them only as "possible later", if at all.

## 3. Constraint (already in the User's instructions; agents recommend keeping it)
Keep agent-room small enough to read in one sitting; add only what the current cycle needs
(the lesson from AgentTalk). The scope sentence changes; the simplicity rule doesn't. No new
decision needed unless the User wants to change it. (Codex)

## 4. Files and what to do
| File | Action |
|---|---|
| `AGENT.md`, `CLAUDE.md` | Replace "basic multi-agent conversation" with the approved goal; keep the rules |
| `README.md` | Goal and first cycle at the top; current behaviour stays accurate |
| `README-for-brainstorming-agents.md` | Update "The overarching goal" and "Project constraint" to match |
| `proposal/agent-room-visual-harness.md`, `../deferred/core-and-ui.md`, `../deferred/crit-vibeyard.md`, `../deferred/edu-app-tooling.md` | Add a notice at the top: "Outside the current implementation cycle (2026-10-20); see `discussion-ide.md`." Earlier User decisions keep their status; don't rewrite content |

This list is a starting inventory. The worker also searches the repository for other
conflicting scope statements, and checks documented commands against the code. Report
any further changes. (Codex)

Known example to flag, not fix (it's code): the comment at `src/agents.mjs:18-19` says the
read tools need no approval. In this session, Claude's reads outside agent-room were refused
until the User granted access (observed 2026-10-20). Flag the comment as potentially
misleading; the cause of the refusal isn't established, so don't recommend a permissions
change. (Codex qualification)

**Resolved since (2026-10-20):** the cause was established and fixed in commit `8463c3d`.
`Read`, `Grep` and `Glob` weren't pre-approved, and outside the working directory they need an
approval that headless Claude can't ask for. They are pre-approved now, and the comment (now
`src/agents.mjs:17-19`) says so. Nothing left to flag.

## 5. Limits for the worker
- Documentation only: no code, no tests.
- Don't settle product questions through edits. Flag any contradiction you find and leave it
  for the User.
- Report every file changed and what changed; say what you didn't check.

## Open questions for the User
None left. Both were answered on 2026-10-20 (see the status line at the top): the User
approved the goal sentence in §1 and the file list in §4, notices included.
