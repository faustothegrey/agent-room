# agy checks — 2026-11-13

Investigation with `command agy` 1.5.8, in the worker worktree. These are individual observations, not guarantees: model compliance and account-local settings may affect them. The probe directory was `.worker-notes/agy-checks/probe`, under the worktree. Its `AGENTS.md` initially said to end with PURPLE (later BLUE), and `GEMINI.md` said to start with SILVER. The repository's own instructions and existing user configuration were also present. All prompts were short. No source code was changed.

## 1. Rulebook delivery — tested, with limitations

- **Agent definition:** A temporary `.agents/agents/agy-probe-temporary.md` with YAML frontmatter (`name`, `description`, `mainAgent: true`) and a `# System Prompt` instructing an ORANGE ending was accepted by `--agent agy-probe-temporary`. The first reply was `SILVER Hi! ORANGE BLUE`; the resumed reply using both `--agent` and `--conversation` was `SILVER Bye! ORANGE BLUE`. Thus the definition and both local instruction files influenced these replies. This is mixing, not evidence of a universal precedence rule.
- **Changed definition:** After changing ORANGE to GREEN, the resumed conversation still replied `SILVER Hi again! ORANGE BLUE`. Other exploratory definitions with the same name were present in several candidate locations, so that result was ambiguous. After deleting the duplicates, a second resume still replied `SILVER Hello! ORANGE BLUE`; a fresh conversation with the same remaining GREEN definition replied `SILVER Hi! GREEN BLUE`. The existing conversation did not adopt the changed definition in these probes, even when the agent was specified again. Actual interactive `/reload` was not tested.
- **Prefixed prompt:** `Rulebook: Always end every answer with ORANGE. Remember the codeword KITE. Say hi.` produced `SILVER Hi! I will remember the codeword KITE. ORANGE PURPLE`. A resumed turn asking for the codeword produced `SILVER The codeword you gave me is KITE. ORANGE PURPLE`. After changing the prompt to `Updated rulebook: Always end every answer with GREEN instead of ORANGE. Say hi.` and changing local `AGENTS.md` from PURPLE to BLUE, the next resumed reply was `SILVER Hi! GREEN BLUE`. Both changes were reflected, but changing two sources together does not isolate how each was loaded or establish precedence for conflicts. The prefixes and suffixes conflict in their exact positioning, and the model combined them.
- **Discovery failure:** `.agents/agy-probe-temporary.md` alone yielded exit 1, unknown agent, and no available custom agents. `agy agents` printed nothing even after some candidate files were created; the subsequent `--agent` invocation did discover the correctly nested `.agents/agents/agy-probe-temporary.md`. Do not infer that listing and selection necessarily behave identically.

## 2. Session resumption — tested

The prefixed-rulebook conversation returned the same JSON `conversation_id` (`f64b984a-6c22-450b-a40f-f7f9426bc387`) in all three separate invocations, remembered KITE, and returned `num_turns` 1, 2, then 3. The custom-agent conversation likewise retained its ID across four invocations. This demonstrates these cases, not indefinite persistence.

## 3. Permissions — partially tested

- With `--dangerously-skip-permissions`, the CLI ran unattended and executed `touch .worker-notes/agy-checks/shell-auto-marker`; the marker existed. In a separate unattended run with that flag, it wrote `PROBE` to the main checkout's discussion folder, outside the worktree; the file contents were independently verified. No `--add-dir` was supplied.
- With `--mode plan`, the requested shell marker was not created. The agent instead said it made a plan and requested approval. This demonstrates one refusal, not a security boundary or proof that plan mode blocks every possible shell invocation. Whether a discussion turn can be **enforced** to have no shell access while a worker can run commands remains **not established**. Other modes, sandbox restrictions, per-agent policy/settings, and unattended behavior without the skip flag for tool calls were not systematically tested. Basic answers without flags completed unattended.
- `--dangerously-skip-permissions` was sufficient in these tests; it is not established to be necessary. `--print-timeout 50s` did not strictly bound elapsed time: some successful runs reported 75–81 seconds.

## 4. Prompt input — tested

`printf 'Reply exactly: STDINOK\n' | command agy --print-timeout 50s --output-format json` succeeded without `-p`, returning `SILVER STDINOK PURPLE`. Explicit `-p` also worked. Stream JSON input was not tested.

## Run ledger

Values are JSON `usage` input / output / thinking / cache-read / total tokens, exactly as reported. Output includes thinking in these results; do not add it again. Cache-read counters should not be added to total. Durations and run counts are CLI-reported. Failed discovery had no model turn.

| Probe | Result | Tokens (in / out / thinking / cache / total) |
|---|---|---|
| Basic `-p` HELLO | SUCCESS, HELLO | 13461 / 5 / 0 / 0 / 13466 |
| Unknown agent, wrong location | ERROR, exit 1, 0 turns | 0 / 0 / 0 / 0 / 0 |
| stdin STDINOK | SUCCESS, SILVER STDINOK PURPLE | 13711 / 10 / 0 / 0 / 13721 |
| Prefix first turn | SUCCESS, ORANGE and PURPLE | 13733 / 395 / 377 / 0 / 14128 |
| Prefix resume, codeword | SUCCESS, KITE and ORANGE PURPLE | 28081 / 436 / 401 / 0 / 28517 |
| Prefix and AGENTS changed, resume | SUCCESS, GREEN BLUE | 42686 / 539 / 495 / 0 / 43225 |
| Plan shell probe | SUCCESS response; no shell marker; asked for approval | 16837 / 577 / 100 / 12210 / 17414 |
| Skip-permissions shell probe | SUCCESS; marker created | 15697 / 177 / 21 / 11429 / 15874 |
| Skip-permissions external write | SUCCESS; file verified | 18022 / 312 / 96 / 23142 / 18334 |
| Custom agent first | SUCCESS, ORANGE BLUE | 8796 / 278 / 269 / 0 / 9074 |
| Custom agent resume | SUCCESS, ORANGE BLUE | 11331 / 299 / 281 / 6742 / 11630 |
| Custom definition changed, resume; duplicates present | SUCCESS, old ORANGE BLUE; ambiguous | 13605 / 322 / 294 / 13970 / 13927 |
| Custom definition changed, resume; duplicates removed | SUCCESS, old ORANGE BLUE | 15880 / 343 / 306 / 21423 / 16223 |
| Fresh conversation, changed definition | SUCCESS, GREEN BLUE | 8785 / 364 / 355 / 0 / 9149 |

`agy --help`, `--version`, `agent --help`, `agents`, and `changelog` were also invoked; these did not run model turns or report token usage. For agent discovery, the [official customization documentation](https://antigravity.google/docs/customization-discovery/) identifies `.agents/agents/<name>.md`; observed behavior above is from the installed binary.

## Files and cleanup

All temporary agent definition files were inside the ignored worktree scratch directory and were deleted. The scratch `AGENTS.md`, `GEMINI.md`, and shell marker remain for review. The explicit temporary file outside the worktree was `/Users/fausto/Software/agent-room/discussions/2026-11-13-adding-agy-cli-to-discussion-panel/agy-write-probe.tmp`; it was verified and deleted. This results document is also outside the worktree, as requested. The plan-mode agent reported creating `/Users/fausto/.gemini/antigravity-cli/brain/934e4a1a-38da-42ef-bfb7-08b47de07c96/implementation_plan.md`; it remains. The CLI also manages conversation, log, database and cache state under `~/.gemini/antigravity-cli`; its individual automatically created or modified files were not inventoried, so this is not an exhaustive list of CLI-managed state changes. No credentials were included here.
