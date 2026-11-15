# Auto dev: questions before implementing (worker, 2026-11-09)

Nothing is implemented yet. Each question comes with the worker's proposed default.

1. **Retry or mere quote?** A summary after a report can quote exactly the instruction already
   sent, with `Outcome: SEND`. Code can't tell an explicit retry from a mere quote by the text.
   *Proposed:* at most one send per worker report. The first agreed `SEND` summary after the
   latest report sends, even if the text repeats (a retry). Any later summary before the next
   report sends nothing, whatever it quotes. The prompt tells agents to use `SEND` only for a
   retry they mean.
2. **A worker failure** (timeout, crash, no worktree). *Proposed:* relay its error to the
   Discussion as the "Worker report", as with any reply, so the agents review it and decide.
   A failed *discussion* turn pauses the run.
3. **A round where every agent passes** after a report. Auto-summarize normally skips such a
   round, but then the run couldn't decide. *Proposed:* during a run, always summarize after a
   report's round.
4. **Which User messages pause the run?** *Proposed:* a message typed in the Discussion, and
   also an instruction typed in the Worker tab (it changes the worker's context too).
5. **What ends a run besides its outcomes?** *Proposed:* Pause discussion, New discussion,
   New brainstorm, Re-open, Resume, Restart and Quit all end it, with no recovery. Reload keeps it.
6. **Reading the instruction from the summary.** *Proposed:* the text after
   `Send to the Worker: "` up to the last `"` before the summary's next section (`**Later**`) or
   its `Outcome:` line, so instructions with quotes and several paragraphs come through whole.
   A summary without that shape offers no Start button and can't send.
