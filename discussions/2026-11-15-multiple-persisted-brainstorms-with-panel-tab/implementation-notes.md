# Implementation notes (worker), saved brainstorms

Branch `worker/2026-11-15-multiple-persisted-brainstorms-with-panel-tab`.

## Dependency merged into this branch
The Brainstorms tab shares the Discussions tab's drag-and-drop code, which was only on
`worker/2026-11-15-drag-and-drop-sorting-for-discussions-tab` (772c311, identical to what is staged
in the room's checkout). This branch merges that commit (66c0e26), so merging this branch brings it too.

## How it works (code: `src/ui.mjs`, `src/docs.mjs`)
- A brainstorm is a context with `state.brainstorm = true` and, after its first message,
  `ctx.discussion = { name, dir: <root>/brainstorms/<name>, title }`, the same as a discussion's.
  So transcripts, checkpoints, Close and Restart reuse the discussion code.
- Commands: `/resume brainstorms/<name>`, `/fresh brainstorms/<name>`, `/convert brainstorms/<name>`,
  `/delete brainstorms/<name>`, `/close <ref>` (a row's Close for one open in another context).
- Checkpoint key `brainstorms/<name>`, with `brainstorm: true` and no worker fields. Discussion keys unchanged.
- Turn into a discussion: `mkdir discussions/<name>` (fails if it exists), then rename onto it. The
  checkpoint moves to `<name>`. The agents get the notice through `state.restored`: at once if the
  brainstorm is open, otherwise saved in the checkpoint and combined with the restore notice at Resume.
  The worker's session in the moved checkpoint is a new one, never run.
- Worker: `queueWork` refuses in a brainstorm; the page disables the Worker box with the message.
- Not done on purpose: brainstorms are not replicated (`--node`); `saveRound` skips them.

## Not checked
- Conversion uses scripted turns on the real Claude, Codex and agy adapters: the session IDs survive
  and each agent's prompt carries the notice. No real provider CLI was run.
- The Brainstorms tab and Actions ▾ were not tried in a browser: the page script is only checked to
  parse, and the drag-and-drop test covers the shared code through the Discussions tab.
