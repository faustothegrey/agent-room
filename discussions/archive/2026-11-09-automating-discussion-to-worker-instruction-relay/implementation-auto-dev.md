# Implementation notes: auto dev (worker, 2026-11-09)

Uncommitted on `worker/main`. No new module, dependency or config. `worker/main` is never merged.

## How it works
- **State:** `ctx.autoDev` holds the run: `{ status: running | paused | finished, cycle, reason,
  waiting, report }`. `ctx.autoDevSent` lists the summaries already sent (their transcript
  indexes). Both live in `ctx`, so a Reload keeps them.
- **Start / Restart:** `/autodev` (the page's buttons) takes the latest agreed summary. It refuses,
  with the reason, in a brainstorm, before a discussion starts, while paused, when already running,
  when the worker is disabled, when that summary was already sent, or when its instruction can't
  be read.
- **Relay:** the instruction is queued to the worker like a typed one. It is shown and logged as
  "Relayed from discussion → W (worker, auto dev cycle n of 5)". The worker's reply, or its failure
  as "The worker's attempt failed: …", is queued into the room's input (`/autodev report`). It then
  runs a round whose opening message is from "Worker report", sent to all agents.
- **Decide:** a report's round is always summarized while the run is running. The summary prompt
  gets extra lines: passing accepts the quoted instruction exactly, and the summary ends with
  `Outcome: SEND / FINISH / WAIT FOR USER`. Only that summary decides, so there is one send per
  report. A `/summary` you ask for meanwhile decides nothing.
- **Pause reasons:** WAIT FOR USER, not agreed, empty summary, a failed summary turn, a failed
  discussion turn, no Outcome line, an unreadable instruction, "5 cycles used", "you sent a
  message", "you sent the Worker an instruction", and "the worker's result was lost in the Reload".
- **What ends a run:** Pause discussion, Resume, New discussion, New brainstorm and Re-open set it to
  none (through `endSession`). Restart and Quit lose it with the memory. A relay still running then
  reports only in the Worker tab.
- **Page:** "Start auto dev" with its note sits inside the latest agreed summary, before its
  **Later** section. When the instruction can't be read, it shows why instead. A box above the
  message box shows "Auto dev running · cycle n of 5 · worker is working / discussion is reviewing",
  or the paused state with the reason, the next agreed instruction and "Restart auto dev (5 more)",
  or "Auto dev finished. Review and merge worker/main yourself."

## Files
`src/ui.mjs`, `src/room.mjs` (a round's opening speaker and a summary's extra lines), `src/docs.mjs`,
`README.md`, `test/ui.test.mjs` (5 tests).

## Review changes
- When an instruction is handed to the worker, the conversation gets a notice from "Auto dev":
  `Auto dev sent the instruction "<first line>" to the Worker (cycle n of 5).` The agents receive it,
  and it goes into the transcript and onto the page. It's added in relay(), which runs between
  rounds.
- `README-for-brainstorming-agents.md`: the dispatch notice confirms the instruction was sent;
  remove it from `pending-instructions.md`.
- The status under the title reads "Auto dev running" while a run is running, instead of "your turn".
