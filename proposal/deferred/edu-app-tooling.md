# Tooling for vibecoded maths & science educational apps

> **Deferred research — 2026-11-02.** Kept for possible future work, not the current implementation plan. Product descriptions and external research below are historical and have not been rechecked. See [the proposal index](../README.md) for current work.

> Outside the current implementation cycle (2026-10-20); see `../archive/discussion-ide.md`.

## Goal (from User)
Build engaging educational apps, especially for maths and science, entirely by vibecoding.
The User is open to a custom IDE, an existing tool, or a fork.

## Decided (by the User, 2026-10-20)
- The thing to build is **agent-room itself, extended with a visual harness**: agents and the
  User interact visually around a live preview, to develop UI and animations.
- Harness: build our own, or find one online and modify it (still open which).
- **Running cost is a requirement.** Relying on browser view for every operation is
  considered unsustainable.

## Proposed reaction (Claude)
- agent-room already provides the multi-agent conversation; the missing pieces are a
  preview, a way to point at things, and a hand-off to a worker.
- Reuse a small open-source selection tool (React Grab is the documented candidate) rather
  than a whole IDE. Cursor and Stagewise are complete workspaces with their own chat, so
  they're harder to combine with agent-room's group conversation.
- Cost model: selections travel as short text; the app exposes its state as JSON; browser
  screenshots only on request. Note that browser tools cost context just by being loaded.
- Tension to resolve: agent-room's CLAUDE.md says it should stay a basic, small conversation
  tool. The owner decides whether the harness lives inside it or beside it.

## Proposed (by agents, not decided)
- **Start with existing tools** (Claude Code / Cursor / Codex) plus a template project:
  curated domain libraries (KaTeX, JSXGraph, matter.js, D3), live browser preview,
  and project rules for pedagogy and maths checks. (Claude, Codex agree)
- **Pilot app to test the workflow:** the User's preferred first app should be the pilot.
  The projectile exploration (learners predict the landing point, change launch conditions,
  then compare) is only an agent example, not an agreed pilot. (Codex)
- **Pilot should also check visual honesty:** scales, trajectories and graph axes must match
  the underlying numbers. (Claude)
- **Evaluate the pilot on:** whether the interaction can be revised entirely by conversation;
  whether the agent can inspect the rendered app; whether equations, units and limiting
  cases get checked; whether a working version can be kept while exploring alternatives. (Codex)
- **Decision rule:** build a custom workspace or fork only if the pilot reveals a repeated
  obstacle that existing tools can't handle comfortably. (Codex; Claude agrees)
- **Working definition of "engaging":** predict → manipulate → see consequences → explain;
  animation alone doesn't count. (Codex)

## Development loop (User's main concern)
User wants: live preview, ongoing chat with one or more agents, a worker agent, and a cheap
way to discuss the preview with agents (little or no browser screenshotting). Ideally, point
at a UI element or animation and hand that reference to the agent.

### Proposed (Claude)
- **Point-and-reference rather than screenshots:** clicking an element produces a small text
  packet (component name, source file:line, key props/state, computed size and position).
  Existing pieces: LocatorJS / click-to-component, Stagewise, React Grab, Onlook, Cursor's
  element picker. These still need to be tested.
- **Debug API in every app:** e.g. `window.__app` exposes state, parameters and an animation
  clock (pause, seek). Agents read and assert on JSON, not pixels.
- **Animations as state traces:** "frames 30–60, ball.y goes below 0" rather than video.
- **Screenshots only on request**, cropped to the selected element.
### Proposed (Codex)
- **Two cases.** For DOM elements, a selection gives identity, owning component and state.
  For canvas/WebGL, the app itself must identify objects inside the scene (e.g. "velocity
  arrow, particle B"), which needs a small integration in the edu components.
- **Selection captures the moment:** paused time, parameters and the selected object, so
  "see this?" still refers to the same thing when the worker looks.
- **Workflow:** point → attach to chat → discuss → worker edits → preview updates. Context
  starts with the compact selection; the agent asks for state, a trace or a cropped
  screenshot only when needed. Visual inspection still matters for judging appearance.
- **Reframe:** the question is "which preview-to-agent bridge?", not "which IDE?".
- Token savings must be measured, not assumed.

### Criteria for comparing bridges (synthesis)
1. DOM element → source file:line + state
2. Canvas object picking (probably not offered by existing tools; likely the custom piece)
3. Selection captures the moment (time, parameters, object) with an option to pause, plus a
   short trace around it, because sometimes the problem is the motion itself (Codex)
4. Works with the chosen agent CLI (Claude Code / Codex)
5. **Discussion–worker coordination** (Codex): a selection attaches to the chat without
   starting an edit; when the User asks for a change, the worker gets the relevant
   discussion, the selection and the preview version it came from; afterwards the worker
   reports what changed and whether the selection still identifies the same object.
6. **Measure the whole loop** (Codex): User effort, elapsed time, context sent, and whether
   the change matched the intent, not just tokens. A tiny packet that causes misunderstandings
   can cost more overall.

None of these is yet confirmed against existing tools. Framework compatibility should come
out of the comparison rather than be chosen first; a React UI plus a canvas simulation in one
app is normal. (Codex; Claude agrees)

## Unresolved: what counts as core vs extension
- **Codex:** the core is select element → attach to chat → explicit hand-off to the worker →
  inspect the updated preview. Simulation state capture and motion traces stay extensions
  until we know how much the User's apps need them.
- **Claude:** agrees on that core, but would put *picking objects inside an animation* in the
  core too, because the User explicitly asked to point at "an element of the UI or animation".
  State capture and traces can stay extensions.
- **Resolved between agents (not a User decision):** animation selection is in the core
  evaluation, but how precise it must be stays open. Three levels (Codex):
  1. Point at a region → screenshot + comment
  2. Identify the specific object under the pointer
  3. Link that object to its source code and runtime state
  The User is not asked to pick a level now (Codex; Claude agrees). Target experience:
  "I point at this moving thing, explain the change, and the agent understands." Next step:
  compare how existing tools deliver it, report their limits, then put concrete tradeoffs
  to the User (e.g. is an occasional cropped screenshot acceptable?).

### Possible thin custom layer (Claude)
- **Possible thin custom layer:** preview + picker + chat in one window, wired to an
  existing agent CLI. This would be a small tool, not an IDE fork.

## Candidate comparison (skeleton)
Status key: **memory** = from agent training knowledge, unverified · **docs** = checked
against current docs · **tested** = actually tried. Token cost stays "unknown" until measured.

| Candidate | DOM pick → source | Canvas object pick | Chat separate from edit | Works with Claude Code/Codex | Status |
|---|---|---|---|---|---|
| Stagewise | DOM selection documented; source/state detail unverified | unknown | unknown | Built-in agents/models documented; external CLI hand-off unverified | docs (partial) |
| React Grab | Element + component stack + source locations documented | unknown | Copy/paste allows discussion before requesting edits | Text context can be pasted into an agent; dedicated integration unverified | docs (partial) |
| LocatorJS (click-to-component alternative not checked) | Component → editor documented | unknown | Not documented as chat bridge | Editor navigation; agent hand-off unverified | docs (partial) |
| Onlook | DOM → code mapping documented | unknown | AI chat documented; separate worker hand-off unverified | External CLI integration unverified | docs (partial) |
| Cursor Design Mode | Element + code, styles, props and screenshot documented | Frozen-frame region annotation documented; semantic canvas identity unverified | Add-to-chat/input documented; discussion-only flow untested | Cursor agents; external CLI hand-off unverified | docs (partial) |
| Claude Code + Claude in Chrome | DOM reading documented; user pick → source unverified | Semantic picking unverified | Browser tools usable in plan mode; selection hand-off unverified | Claude Code integration documented | docs (partial) |

### Official-source check (Codex, 2026-10-20)
- [React Grab README](https://github.com/aidenybai/react-grab): documents hover → copy →
  paste into an agent, including element markup and component source locations. Also exposes
  primitives for element hit testing and page freezing. This establishes a text-context
  route, not arbitrary canvas-object identification or runtime-state capture. Its performance
  claims have not been independently checked here.
- [Stagewise docs](https://docs.stagewise.io/): describes a standalone desktop agentic IDE,
  with browser, chat, DOM selections as agent context, and diff review. Thus the earlier
  mental model of merely an editor toolbar is incomplete. Provider/model support does not
  establish compatibility with an external agent CLI or this room's discussion/worker model.
- These are documentation checks only. No tools installed or exercised; token costs,
  animation selection, selection persistence, and complete workflow remain unmeasured.
- [Cursor Design Mode](https://prod.cursor.com/docs/agent/design-mode): documents selecting
  elements with code context, adding selections to chat/input, drawing over a frozen viewport
  frame (including animated pages), and hot reload after edits. Context includes element
  identity, component, attributes, computed styles, fiber props, and a screenshot. This is
  documented support for region-based animation reference, not proven semantic canvas picking.
  Screenshot-free selection and token costs remain unverified.
- [Onlook README](https://github.com/onlook-dev/onlook): documents DOM instrumentation mapping
  elements to source, AI chat, and real-time preview for Next.js + Tailwind. Distinguishes the
  open-source editor from a newer hosted early-access product; do not assume feature parity.
- [Claude Code Chrome docs](https://code.claude.com/docs/en/chrome): documents DOM/console
  inspection, local-app testing, screenshots and GIF recording. Explicitly warns that enabling
  Chrome by default adds context usage from browser tools/instructions. User pointing → source
  reference is not established by this page.
- [LocatorJS](https://www.locatorjs.com/): documents clicking a component to open code in an
  IDE, via extension or library, across several frameworks. An agent-chat bridge is unverified.
- Absence of a documented feature in these checks is not evidence that it cannot be supported.

### Proposed shortlist after documentation checks (Codex)
- Compare Cursor Design Mode and Stagewise as integrated-workspace candidates, with React
  Grab as the lightweight text-context baseline. This is a proposal, not a User decision.
- Cursor's frozen-frame annotation directly addresses the simplest animation-reference case;
  it weakens the assumption that custom canvas integration must be built first.
- No hands-on testing or token measurement performed. Do not install tools, create a test app,
  or extend agent-room under this proposal-only room's scope.
- **Add a control (Claude):** keep Claude Code + Claude in Chrome in the comparison as the
  reference loop, since token savings can only be measured against a baseline. Evidence on
  installation: the User's global Claude Code config notes the Chrome extension has been
  installed and connected since July 2026. That is a config note, not a check of its current
  state. (Codex had flagged installation as unestablished.)

### Proposed trial protocol (Claude; for the User to approve and run outside this room)
- One test page: DOM controls (slider, labels) plus a canvas with two overlapping moving objects.
- The same five "see this?" requests in every tool, e.g. restyle a label; change a slider's
  range; "this arrow is too long at t≈2s"; "this particle should bounce, not pass through";
  "the axis labels don't match the numbers".
- Record per request: did the agent target the right thing on the first try, number of
  clarification turns, minutes elapsed, tokens/cost if the tool reports them, and whether
  the change matched the intent.
- **Persistence check (Codex):** after the scene moves and code changes, a follow-up like
  "now make that same particle leave a trail". Does the reference still hit the same object?
- **Discussion-only check (Codex):** point at the scene and ask "what are two ways we could
  change this? Don't edit yet." This tests the ongoing-conversation requirement.
- Results show which limits interrupt the User's cycle *for these examples*; they don't
  prove in general whether custom canvas support is needed. (Codex correction, accepted)

### Two routes and the shared gap (Claude, synthesis)
- **Route A:** a lightweight bridge (e.g. React Grab) into the User's chosen conversation tool.
- **Route B:** an integrated workspace (e.g. Stagewise).
- Neither documents picking objects inside a canvas. That is an *unverified capability*, not
  yet a proven gap. (Codex correction, accepted)
- If custom support turns out to be needed, it is more than naming objects: the app must work
  out which object was clicked, including overlapping or moving ones, and that depends on how
  the scene is drawn. Start with one representative scene, not a general interface. (Codex)
- React Grab's "page freezing" is not yet known to pause a running simulation. (Codex)
- **Route A candidate (Claude):** agent-room itself is already a multi-agent chat. A selection
  tool could paste into it, and a worker agent could take hand-offs from it. Caveat:
  agent-room's own rules keep it deliberately small, so this would need the owner's approval
  and could conflict with that goal.
- Next: check remaining candidates (Onlook, Cursor picker, Claude in Chrome) against official
  docs, then test on one representative scene.

## Hypotheses kept alive
- The real need may be a workspace for *designing interactions* (for example, a lesson canvas),
  not a better code editor. It could pay off even with the User as sole author, if turning
  ideas into inspectable, editable learning experiences keeps causing friction. Whether
  teachers will also author is a separate question. (Codex)
- The tooling choice stays open until the User describes what they want to build.

## Open questions for the User
1. Who builds the apps: only you, or teachers too?
2. Who uses them: what ages, on which devices (web, tablet, offline)?
3. Do the apps need to save learner progress or integrate with an LMS?
4. What does "engaging" mean to you? Does the definition above fit?
5. Which single learning experience do you want to build first?
6. Once tested: does an existing integrated workspace (Route B) feel more comfortable in
   practice than a chat tool plus a separate preview (Route A)? (reframed per Codex)
7. Would you consider agent-room as the chat side of Route A, given that it's meant to stay small?

## Unresolved disagreements
- None open. Core vs extension was settled between agents (see section above); the required
  precision is a User question.
