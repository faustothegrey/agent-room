# Repurposing the docs: agent–human collaboration platform

## Decided (by the User, 2026-11-11)
- agent-room is an **agents-and-human collaboration platform**; the docs must say so, with clear,
  visual architecture documentation, a clear split between skills and harness, and mainstream conventions.
- The educational maths/science purpose is **dropped**: at most one application among many;
  agent-room stays domain-agnostic. Mentions to remove: `README.md:8`,
  `README-for-brainstorming-agents.md:23` and `:29` ("educational material").
- **"Harness"** (loose sense): a deterministic engine wrapped around the agents' semantic work.
  - **Provider CLI harness** (Claude Code CLI, Codex CLI): *required*; gives the model its basic
    means of acting on its environment.
  - **Room harness** (agent-room, also "orchestrator"): steers and makes use of those
    capabilities, and may add tools to extend them.
- **Core capability = the full agent CLI.** Git is needed only for replication / secondary servers,
  and for a worker only when it gets a coding task (which depends on the room's goal).
- The three draft diagrams were reviewed and look OK to the User: `drawings/c4-context-draft.svg`,
  `drawings/c4-containers-draft.svg`, `drawings/discussion-round-sequence-draft.svg`. The steps after
  a round are now traced in `src/ui.mjs:1783-1804`, and the sequence diagram is corrected to match.

- Role instructions may become Agent Skills packages (better for future, more complex scenarios).
- **A-priori behaviours** = those without which the main loop can't operate reliably. They must be
  enforced very strongly, from the start, on every agent taking part.

- The architecture document belongs to the whole project: it lives in **`docs/`**, with the
  diagrams beside it. The root `README.md` is revised to match, with no historical information
  unless it is crucial to the current architecture. The draft worker instruction is in
  `pending-instructions.md`.

- **Done, 2026-11-11:** the worker's commits `0c54a9d` and `ec9016a` were merged into main.
  `docs/architecture.md` and `docs/diagrams/` are now the authoritative copies; the drafts in this
  discussion's `drawings/` are history.

## Core protocol (decided by the User, 2026-11-11)
1. Reply only as yourself; never write lines for others.
2. Reply exactly `PASS` when you have nothing to add.
3. Give one final text reply per turn; don't wait for input.
4. **Follow the summary format and its specification exactly.** The User considers summarizing the
   most valuable feature, the one that keeps all of this manageable. The format may change or grow,
   but only with extreme caution and care.

Instructions encourage these rules; they can't guarantee them. The code recognizes `PASS` / `PASS.`
and the fields auto dev needs. It can't verify that an agent really had nothing to add, nor that a
summary's content is right.

## Summary contract page (decided by the User, 2026-11-11)
The architecture docs describe the current summary structure, and note that it may be revised in
future if ever needed. A short page covering:
- the format agents are asked to follow (`src/room.mjs:9-25`; auto dev additions `src/ui.mjs:1208-1217`);
- what the code actually parses (`PASS` for agreement; `Next step` / `Send to the Worker: "…"` /
  `Outcome:` in `src/ui.mjs:1221-1226`);
- what happens on failure (no agreement → shown "not agreed"; an unreadable instruction → not sent, reason shown);
- the tests that cover it (`test/room.test.mjs`, `test/ui.test.mjs`).
It also notes that the summary prompt is part of the room harness, not a rulebook. How changes to
the format are reviewed is a separate decision.

## Current facts (traced in code, 2026-11-11)
- Main loop: `round()` in `src/room.mjs:121-137`. Turns in order, at most 8; it stops when everyone
  passes in a row, a turn fails, or the cap is reached. Consecutive passes are a stopping rule, not
  proof of agreement; reaching the cap is not proof of failure.
- What the loop needs from an agent before any injected instruction: headless turns, a usable reply
  and a resumable session. To end by passes, it also needs instruction-following good enough to use
  the injected `PASS` protocol. Usage data is optional.
- The room harness steers the CLIs through **launch flags** (tools, sandbox, model:
  `src/agents.mjs:67-74`, `:123-126`) and **role instructions** (the rulebooks plus prompts added per
  turn). It adds no tools of its own today.
- Claude: tools are listed explicitly. Discussion agents have no Bash; the worker has Bash.
  `--strict-mcp-config` without `--mcp-config` means no external MCP servers
  ([CLI reference](https://code.claude.com/docs/en/cli-reference), documented); the Chrome tools
  come from `--chrome`. Codex: full access plus live web search; its MCP handling is **unchecked**.
- The worker needs a Git repository for every task (its worktree), not only coding tasks. This
  differs from the User's core model; whether to change it is open.
- Output contracts: the summary format and auto dev's `Next step` / `Send to the Worker: "…"` /
  `Outcome:` lines are sent with the turn's prompt by the harness (`src/room.mjs:16-25`,
  `src/ui.mjs:1208-1217`) and parsed by it (`src/ui.mjs:1221-1226`). The parsing checks form, not content.
- `README.md:7` says seven source modules; `src/` has eight (`host-shell.mjs` is missing from the count).

## Proposed (Claude and Codex), awaiting the User
- Terms: **role instructions** = agent-room's protocols (not Agent Skills packages); **skills** =
  optional Agent Skills packages from the provider or the User (agent-room ships none). Always
  qualify "harness" as provider CLI harness or room harness.
- Docs show three ways the room harness steers: flags, instructions, and (only as a possibility,
  not a commitment to MCP) its own tools via `--mcp-config` or similar.
- The architecture doc is the authoritative description of the harness; role instructions keep a
  short "what the harness does around you" section that links to it.
- Mark rules **enforced**, **contract** or **instruction** only where an instruction could be
  mistaken for an enforced limit. For each contract, say what is expected, what the code checks,
  and what happens on failure.
- Conventions: `AGENTS.md` for agents working on the repo (documented below); C4 levels only where
  useful ([c4model.com](https://c4model.com/diagrams)); short ADRs written *from* settled
  discussions, each linking its source ([ADR templates](https://adr.github.io/adr-templates/));
  Diátaxis split of the README (how-to / reference / explanation; assumed, from memory).
- Document the current Bash and Git restrictions as implementation facts; any change is a separate decision.

## Checked against sources (documented)
- [agents.md](https://agents.md/): a "README for agents" at the repo root; nested files apply to
  subprojects (nearest wins); no required fields; suggests symlinking old filenames; stewarded by
  the Agentic AI Foundation (Linux Foundation).
- [Agent Skills spec](https://agentskills.io/specification): a folder with `SKILL.md` (`name`,
  `description`), optional `scripts/`, `references/`, `assets/`; usually loaded progressively.
  A host *could* load a skill every turn, but nothing guarantees it, so always-applicable rules stay
  in role instructions. `allowed-tools` is experimental; the provider decides what can actually run.

## Left open when this discussion closed (not started)
1. Rename `AGENT.md` to `AGENTS.md`? This needs a compatibility check first (how each tool finds the file).
2. Before role instructions become Agent Skills packages: verify how both CLIs can reliably
   receive instructions that must apply on every turn.
3. Should the Bash restriction for Claude discussion agents, or the worker's Git requirement, change?
4. Optional: the auto dev notice quotes only an instruction's first line (`src/ui.mjs:1289`)
   without saying it was shortened.
Reviewing worker output before merge has its own discussion:
`discussions/2026-11-11-viewing-worker-output-before-merge/`.
