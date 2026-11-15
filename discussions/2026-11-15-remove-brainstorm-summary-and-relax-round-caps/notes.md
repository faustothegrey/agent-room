# Remove the brainstorm summary step and relax the round cap

## Request (User, 2026-11-15)
"Remove summary step for brainstorm and relax capping of rounds."

## Current behavior (read in the code, not tested)
- **Auto-summary:** after every round where an agent spoke and none failed, `runRound` runs the
  summary (`src/ui.mjs:2132`), adding up to 3 turns per agent (`SUMMARY_TURNS_EACH`,
  `src/room.mjs:9`). Brainstorms get it too; only the prompt differs (`summaryFormat(brainstorm)`).
  - The reply to the retired `/autosummary` command (`src/ui.mjs:1954`) also says auto-summarize follows every round where an agent spoke.
  - Auto dev is already disabled in brainstorms (`src/ui.mjs:1511, 1523`).
- **Round cap:** `MAX_TURNS = 8` agent turns per round, passes included (`src/room.mjs:8`). With 3
  agents that is 2⅔ laps, so a round can stop mid-lap with "(turn cap reached)".
  - Note on `@name` rounds (`selected.length === 1`): after the addressed agent replies on turn 1,
    turn 2 prompts the same agent with no new messages from others (`unseenFor` filters out its own
    reply) so it normally passes on turn 2 (`2 turns = 2 laps`). That second turn is still a real,
    paid call to the model, and the pass is the model's choice, not enforced by code (assumed, not tested).
  - Any higher cap allows longer, costlier rounds; cost per round is unmeasured.
- Where the cap and brainstorm auto-summary are stated/tested: `README.md:90, 414`, `README-for-brainstorming-agents.md:47`,
  `src/ui.mjs:1858` (Quit grace comment), `src/ui.mjs:1954` (`/autosummary` hint, tested for `^Auto-summarize is always on now` at `test/ui.test.mjs:1504`),
  `test/room.test.mjs:109-128` (turn cap tests), and `test/ui.test.mjs:305-322` (`/brainstorm` test currently expects an automatic summary after `handleLine('hello', ctx)`).

## Terminology (Decided by the User)
- **Round:** what happens between two User messages. (Code: `round`. Auto dev's Worker report also
  starts one.) Codex's nuance: in the code, the round is only the agents' turns; the automatic
  summary, when it runs, comes after it, still before the User's next message.
- **Lap:** one trip around the table, every
  selected agent speaking once in order (`Claude → Codex → Agy`).
- **Turn:** one agent speaking once. A `PASS` counts as a turn. (Code: `turn`.)
- **What the code caps today:** turns, not laps: `MAX_TURNS = 8` turns per round, which with 3
  agents is 2⅔ laps (`Claude, Codex, Agy` → `Claude, Codex, Agy` → `Claude, Codex` → stop).

## Decided (User)
- The word is **lap**.
- Drop the automatic summary in brainstorms (manual **Summarize** / `/summary` stays as is).
- Cap counts laps, not turns: at most **10 laps** per round in discussions, **20** in brainstorms.
- Worker instruction draft: `pending-instructions.md` (awaiting User confirmation to send).
- Codex's `@name` point: left to the agents by majority if not crucial (all 3 agents agree: a lap is over the round's selected agents).
- In a brainstorm, agents should discuss as freely as possible.
