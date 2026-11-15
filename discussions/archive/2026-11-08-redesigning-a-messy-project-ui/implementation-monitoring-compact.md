# Compact monitoring zone

Only src/docs.mjs changed, uncommitted on worker/main. Visible week labels become wk, resets becomes at, and the redundant at inside a meter date is removed (Nov 11 at 7:59am → at Nov 11 7:59am). Raw meter data and full hover titles stay unchanged. Horizontal gaps shrink between the server, quota groups, provider names, window labels, bars, percentages and reset text; bars remain 32 px. No font sizes changed.

README does not quote the changed labels, so it is unchanged. No tests changed.

Comparison used the same real quota snapshot read from the 5566 room's __events stream in both versions, served by an isolated preview on 5577. No real server reload or mutation, and no agent turns. Snapshot: Claude 5h 79% at 10:59pm; Claude week 47% at Nov 11 7:59am; Codex 5h 13% at 01:59 on 9 Nov; Codex week 54% at 07:45 on 11 Nov; updated 21:10. The live meter changed later; the preview intentionally froze these captured values for a fair comparison.

Chrome innerWidth was 1440 in both measurements. getBoundingClientRect widths:

| Element | Before | After |
| --- | ---: | ---: |
| Whole amber server/monitoring zone (#server-zone) | 769.078125 px | 642.0625 px |
| Gauges and Usage within it (#monitor) | 669.03125 px | 546.8125 px |
| Discussion zone | 359.1328125 px | 486.1484375 px |
| Header height | 73.8984375 px | 69.96875 px |

All four bar widths remained 32 px. Visual check showed all values, reset times, both windows for both providers and the updated time visible without overlap.

Screenshots:
- /Users/fausto/Software/agent-room.worker/.worker-notes/monitoring-compact/before.png
- /Users/fausto/Software/agent-room.worker/.worker-notes/monitoring-compact/after.png

npm test passed: 116 tests, zero failures. git diff --check passed. Preview server stopped. Not checked: light theme, narrow windows, or live quota updates in the modified page (existing quota-update handling unchanged).
