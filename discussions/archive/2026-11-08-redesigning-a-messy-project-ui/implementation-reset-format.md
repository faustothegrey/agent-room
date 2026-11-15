# Unified quota reset format

Uncommitted on main: src/usage.mjs, src/docs.mjs and test/usage.test.mjs.

The shared usage formatter converts the two existing meter text formats into day + abbreviated month + 24-hour clock. It keeps the wall-clock time and any timezone suffix unchanged. For a reset without a date, it uses the meter’s last_update local date, choosing the next day if the reset clock precedes the measurement clock. Calendar rollover uses UTC arithmetic only, without converting the reset’s timezone. Unrecognized formats remain intact rather than inventing a time.

Header gauge text, hover titles and Usage report now use “at 9 Nov 01:59”. Header values, bars, windows and updated time unchanged. README does not quote the old format and was not edited.

Notified the User before changing tests. Two usage tests quoted the old output: updated their expected display strings and added a fixed measurement date to the gauge fixture. Added coverage for both provider formats, today, next-day midnight, noon, year rollover, equal-minute timestamps, timezone preservation and unknown input. npm test passed: 117 tests, zero failures; git diff --check passed.

Screenshot uses a real quota snapshot captured from room 5566’s __events stream, rendered with the changed modules on isolated preview 5577 (no mutation of live room and no agent turns): Claude 1% / 48%, Codex 55% / 60%, updated 23:05. Resets: Claude at 9 Nov 03:59 and at 11 Nov 07:59; Codex at 9 Nov 01:59 and at 11 Nov 07:45. All values visible in Chrome.

Screenshot: /Users/fausto/Software/agent-room.worker/.worker-notes/reset-format/quota.png

Preview stopped. No commit. Not checked: light theme, narrow widths or unsupported future meter formats beyond safe fallback.
