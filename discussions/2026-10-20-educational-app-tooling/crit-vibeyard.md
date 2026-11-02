# Crit and Vibeyard: preview ideas

> **Deferred research — 2026-11-02.** Kept for possible future work, not the current implementation plan. Product descriptions and external research below are historical and have not been rechecked. See [the discussions index](../README.md) for current work.

> Outside the current implementation cycle (2026-10-20); see `../2026-10-20-discussion-ide/discussion-ide.md`.

Research by Codex, 2026-10-20. Official documentation checked online; neither app installed or exercised. Costs remain unmeasured. This is a proposal, not a User decision.

## Decided by the User

Investigate Crit (crit.md), especially its live preview, and optionally Vibeyard for inspiration. Earlier decisions about a shared preview and running cost remain in `agent-room-visual-harness.md`.

## Documented: Crit

[Live mode](https://crit.md/modes/live) puts the running app inside an iframe through a reverse proxy. Users interact with the page or highlight DOM elements and pin comments. CSS selectors anchor comments across minor layout changes; the page reloads as the app changes. This documents DOM references, not semantic identification of particles inside a canvas.

[The integration protocol](https://crit.md/integrations/build-your-own) exchanges feedback through a JSON review file. The normal command waits for Finish Review, then the agent reads comments, addresses them, replies and starts another round. The reviewer controls resolution. A file-based exchange is worth considering for an adjacent preview, but compatibility with agent-room's turn handling has not been tested.

[The README](https://github.com/tomasz-tomczyk/crit#send-to-agent-experimental) also documents experimental immediate replies through a configured agent command. A live thread automatically forwards later replies and can trigger edits. That differs from our proposed explicit hand-off after group discussion. Its availability does not establish multi-agent room coordination.

[The implementation guide](https://github.com/tomasz-tomczyk/crit/blob/main/docs/live-mode.md) explains that the proxy injects browser scripts and communicates through `postMessage`. It proxies Vite hot-reload connections. Cookie forwarding, script injection and framing can require attention; service workers are disabled in the proxied preview. An app can remain browsable while commenting is unavailable. Thus “wrap any dev server” has practical compatibility limits to test.

## Documented: Vibeyard

The [official README](https://github.com/elirantutia/vibeyard/blob/main/README.md) describes an embedded browser, DOM inspection, and sending the selected element's selector, text and page URL as editing context. It supports Claude Code, Codex CLI and Gemini CLI sessions, and advertises cost/context monitoring. This establishes a relevant preview-to-CLI workflow; it does not establish state capture, source mapping or canvas-object picking.

The [changelog](https://github.com/elirantutia/vibeyard/blob/main/CHANGELOG.md) records a browser-popover option to send to an existing session (0.2.30). Keeping the current conversation is relevant to our loop, although group discussion behaviour remains unverified.

## Proposed by Codex

Prioritise Crit as the next preview candidate: its focused review surface and feedback file make it a closer conceptual fit for keeping agent-room small. This is a recommendation for evaluation, not a decision to add a dependency or process.

Borrow this experience: interact with the app → select and highlight → attach a comment/reference to the room → discuss → User requests an edit → worker reports back → inspect the updated preview. Keep discussion and worker dispatch visibly separate. From Vibeyard, borrow the option to target an existing conversation instead of starting a fresh agent.

The browser drawing an animation is distinct from an AI receiving screenshots continuously. These documented designs suggest that local interaction can produce text feedback on demand; whether this reduces total model cost must still be measured.

An illustrative exchange: select the angle slider and attach “could this show radians too?”; the room compares options without edits; the User chooses one; the worker receives the chosen change and selection. On reload, check the intended control and outcome. Neither product's checked documentation establishes the same exchange for an individual canvas particle.

## Open questions and next evaluation

- Can Crit's feedback be brought into the room before any worker edits, without blocking discussion? Manual transfer is a possible first evaluation, not an implemented integration.
- Do pins still identify the intended element after a representative edit? A CSS selector alone is not proof of semantic continuity.
- Does wrapping the chosen app preserve navigation, hot reload and animation behaviour?
- Can either candidate handle our crossing-dot case? Not established by these docs.

Proposed next step outside this proposal-only room: evaluate one DOM discussion-and-edit exchange with Crit, followed by the animation trial already proposed. Record actual context and cost. No new User choice is required to retain these candidates in the proposal.

## Unresolved disagreements

No new disagreement recorded. Embedded versus adjacent placement remains open; this research does not settle it.
