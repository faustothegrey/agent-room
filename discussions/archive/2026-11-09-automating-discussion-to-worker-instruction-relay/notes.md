# Automating the discussion ↔ worker relay ("auto dev")

Drawing: `drawings/1-relay-loop.svg`

## Decided (by the User)
- Automate only the copy-paste between the Discussion and Worker tabs: instructions out, worker reports back.
- Every message stays visible in the UI and in the transcripts, as now.
- **Start, then continue:** "Start auto dev" approves one instruction; follow-ups then flow without a click each.
- **Cap:** at most 5 worker cycles per start, then the loop pauses for the User.
- **Merging `worker/main` stays manual.**
- **Discussions only:** no auto dev in brainstorms ("by definition, brainstorms produce nothing tangible").

## Agreed between agents (in the summary the User answered; not each separately confirmed by the User)
- **Relays are ordinary messages:** "Relayed from discussion" in the Worker tab, "Worker report" in the Discussion. Both go into the transcripts and the receiving agent's context. The worker's full report is returned.
- **When to send:** only at the end of a round, from an agreed auto-summary. That summary's prompt says passing accepts this exact instruction, and asks for one line: `Outcome: SEND`, `FINISH` or `WAIT FOR USER`.
- **Send once:** each agreed instruction goes once. After a report, SEND needs an explicitly new instruction, even for a retry. FINISH and WAIT FOR USER send nothing.
- **"Done" is reviewed:** the worker's "done" goes back to the discussion. All agents passing in an ordinary round doesn't mean the work is complete.
- **Pauses:** an unagreed summary, `WAIT FOR USER`, the User typing a message (a running worker finishes and reports), or the cap.
- **Auto-summarize:** starting auto dev switches it on for that run only, with a note beside the control. The saved setting doesn't change.


## Decided (by the User) on 2026-11-09: the worker's six questions (`implementation-questions.md`)
1. **One send per worker report:** the first agreed SEND summary after the latest report sends, even if it repeats earlier text (that is the retry). Later summaries before the next report send nothing. The prompt tells agents to say SEND only when they mean it.
2. **Worker failure** (timeout, crash, no worktree) is relayed as the "Worker report" for the discussion to review, and **counts as one of the 5 cycles**. A failed discussion-agent turn pauses the run. This narrows the earlier "a failed turn pauses" rule.
3. **During a run, always summarize** after a worker report's round, even when every agent passes.
4. **Pauses:** a Discussion message or an instruction typed in the Worker tab.
5. **Ends the run, with no recovery:** Pause discussion, New discussion, New brainstorm, Re-open, Resume, Restart, Quit. **Reload keeps it** and preserves the cycle count and what was sent, without sending again. If a pending worker result can't be recovered, the run pauses visibly without retrying (Codex).
6. **Reading the instruction:** only from the summary's Next step section: the text after `Send to the Worker: "` up to the last `"` before **Later** or the `Outcome:` line. When it can't be read reliably, there is no Start button or sending, and the UI says why (Codex).

## Open questions
- None outstanding.

## Worker instruction
Draft in `pending-instructions.md` (sending unconfirmed).
