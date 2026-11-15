# Lightweight brainstorming mode

**Status (2026-11-09): done.** Implemented as commit be8b8ac on worker/main, merged into main by
the User. Live checks (a real brainstorm turn, Summarize, Resume's two clicks, Restart/Quit) were
deferred to normal use by the User's choice.

## Decided (by the User)
- Brainstorming is a lightweight form of discussion: talking and reflecting only.
- It is not meant to produce tangible output and does not need persistence per se.

## Proposed (Claude)
What it would skip, compared with a discussion today (current behavior from `README.md`):
- No title request to Claude, no `discussions/<name>/` folder, no transcript file.
- No handoff, no `pending-instructions.md`, no Archive/Defer/Re-open.
- Agents get a shorter rulebook: don't write files; reading the root is fine.
- Same turn-taking and PASS rules.

## Proposed (Codex)
- Separate "no output expected" (clearly asked) from "nothing saved" (left open).
- Start minimal: open, talk, close ends it. Reading project files stays allowed.
- Defer "turn into discussion" and worker access; if an idea proves useful, ask the agents
  to carry a short summary into a new discussion. Claude agrees: this replaces question 2.

## User, 2026-11-09
- Persistence: whatever is most convenient with the current model; resilience can be sacrificed,
  but no needless code complexity.

## Proposed (Codex, from reading the code, not run; Claude agrees)
- Reuse the existing conversation and turn loop. A brainstorm survives browser refresh and
  Reload (server memory) and is lost on Restart/Quit. No recovery mechanism.
- Code points to adjust: message handling creates a discussion when there is no transcript;
  the agent briefing assumes a folder; the header uses the transcript to decide "started";
  Explorer wording; the summary prompt asks for `pending-instructions.md`.
- Claude: no second rulebook. One short "Brainstorm" section in
  `README-for-brainstorming-agents.md`, plus one line in the first message, and a summary
  prompt without the worker/pending-instructions part.

## Proposed (Codex; Claude agrees)
- **New brainstorm** beside **New discussion**; typing in an empty room keeps today's behavior.
- During a brainstorm, hide Summarize and skip automatic summaries; asking for a summary in
  chat stays possible.
- The rulebook says near its start that document, handoff and persistence rules apply only to
  discussions (not a "write no files" note appended at the end, which would contradict them).

## Decided (by the User, 2026-11-09)
- Overall agreement with the proposal above, with two changes:
  - **Summarize stays** in brainstorms: it is crucial to keep the conversation manageable.
  - **Only one brainstorm**, no list: making a new one discards the old one.

## Decided (by the User, 2026-11-09, "I like it")
- Automatic summaries kept; summary format kept without file sentences; "Send to the Worker"
  allowed, text only in the chat; one brainstorm per room; a discussion ends the brainstorm.
- Worker instruction draft: `pending-instructions.md`.
- New brainstorm ends the current discussion session, keeping its folder and transcripts
  ("not necessarily, but it fits well the current model").

- Resume during a brainstorm replaces it (validated first; two clicks on the button only).
- No live check from the worker's copy before merging: the User accepts the risk and will test
  live after merging.

## Proposed (Claude), after the User's decision (now decided above)
- Summary in a brainstorm: same format, but without the sentences about worker instructions and
  `pending-instructions.md` (there is no folder to keep them in).
- A room still has one conversation at a time: starting or re-opening a discussion also ends the
  brainstorm.

## Open questions for the User (superseded where decided above)
1. When you close or restart, is the brainstorm simply gone? Or kept in memory until you start something else?
2. "Turn into discussion": if a brainstorm turns out useful, should one action promote it
   (create the folder, save what was said as its first transcript)?
3. Is the worker tab available during a brainstorm, or hidden?
4. Should it be the default when you type in a room with no discussion, or an explicit choice
   next to **New discussion**?
