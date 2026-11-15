# Small UI tweaks on main

Added a subtle blue background and left accent to the Explorer discussion in use. Then added a small Archive-button spinner, retained until the moved event rather than merely the command-accepted response. Pending state survives list redraws. Move errors clear it; busy buttons prevent duplicate clicks and carry aria-busy. Reduced-motion users get a static indicator. Applied to both Explorer rows and retained discussion pages. Only src/docs.mjs changed; no commit. Browser animation has not been checked.

Changed the header Discussion Actions trigger to a triangle alone, keeping its Actions tooltip and Discussion actions accessible label. Brightened all three header menu triangles with theme-aware colors and a slight size increase. Existing menu actions unchanged. Browser appearance not checked.

Moved the triangle trigger into a title row directly beside the discussion title, with a .15rem gap; the status remains below. Auto-summarize stays alongside the title/status area. No behavior changes; browser appearance not checked.

Removed flex growth from the discussion title/status block and reduced the gap to Auto-summarize to .5rem. The green zone now fits its content within its existing grid allocation instead of stretching across spare width. Browser appearance not checked.

Added one shared two-row system-message hub beneath both tab views. Discussion notices, round-end status, Worker note/error entries and Worker input HTTP errors use it. It keeps the two latest messages, labels Worker notices, preserves full long text in hover titles, and exposes a polite log to assistive technology. Chat replies and thinking indicators remain in their chats. Previewed two seeded notices in Chrome and switched from Discussion to Worker: both remained below the active input. No agent turns. Preview server stopped. npm test: 116 passed; git diff --check passed. No tests changed and nothing committed. Light theme and narrow widths not checked.

After d96a6e0, restored the discussion zone’s stretch across its grid column up to the monitoring zone. Kept title/status flex growth disabled, so Auto-summarize stays near short titles while longer titles can use the available width. No browser check; uncommitted on main.

Committed the discussion-zone stretch as 5f83ea2 on main. Follow-up: the title status now follows the selected tab. Worker shows <name> is working or idle; Discussion retains its existing paused/thinking/your-turn/read-only states. Removed the Worker thinking line from the chat; kept the input queue hint. Tab changes refresh the title status. This follow-up is uncommitted. Browser behavior not checked.

Committed selected-tab activity as 40e6163. Added a floating down-arrow button to each chat, visible only when away from the bottom. Clicking scrolls smoothly to the latest message; reduced-motion uses an instant jump. Scroll and viewport resize update visibility. Existing follow-new-messages behavior at the bottom remains. Browser-checked both panels with 35 seeded entries: Discussion arrow appeared after scrolling up and returned to entry 35; Worker arrow returned to entry 35 and disappeared at the bottom. No agent turns; preview server stopped. npm test: 116 passed; git diff --check passed. Scroll buttons remain uncommitted. Light theme, narrow widths, reduced-motion and incoming live messages not manually checked.
