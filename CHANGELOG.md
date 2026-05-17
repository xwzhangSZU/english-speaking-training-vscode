# Changelog

All notable changes to the **English Speaking Training** VS Code extension will
be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.36] — 2026-05-18

A recording-flow fluidity pass: both ends of the practice loop — pressing
record, and pressing stop through transcribe/coach/speak — are now fast
and *legible* instead of multi-second frozen stalls behind a wrong or
unchanging status line.

### Fixed
- **Pressing record stalled for seconds with zero feedback.** Every press
  paid an unconditional ~0.9 s sleep plus, when a previous recorder was
  still around, up to ~1.7 s of reclaim — and the device enumeration ran
  via `spawnSync`, which froze the single-threaded extension host so the
  webview could not even repaint. On machines with an iPhone/Continuity
  camera in range the enumeration alone added several more seconds. The
  press path now: (a) replaces the fixed 0.9 s sleep with an adaptive
  readiness poll that returns as soon as `ffmpeg` has actually opened the
  device and written the WAV header (typically well under the old floor,
  while still surfacing the old "exited before it could start" error);
  (b) reclaims a stale recorder with `SIGKILL` and a 0.6 s cap instead of
  `SIGTERM` + 1.5 s; (c) enumerates devices with async `spawn` instead of
  `spawnSync`, so the host stays responsive and progress can paint; and
  (d) memoizes the resolved audio device per session so repeated presses
  skip enumeration entirely (cache invalidated on failure or settings
  change).
- **The session timer counted microphone warm-up.** It started the moment
  you pressed record — i.e. during reclaim/enumeration/arming — so a turn
  read several seconds longer than you actually spoke. The timer now
  starts only when the recorder is genuinely listening.
- **Pressing stop showed "Transcribe" while it was still draining the
  recorder.** The progress strip lit its first stage *before* `ffmpeg`
  was actually stopped — a quit → `SIGINT` → `SIGTERM` → settle drain
  that can run several seconds — so the user watched "Transcribe" pulse
  during a wait that was not transcription, the same opaque mislabel
  record-start had. The strip now appears only when transcription truly
  begins; the drain keeps the honest "Stopping native recorder…" status.
- **Stopping paid an unconditional 150 ms settle every time.** `ffmpeg`
  finalizes and closes the WAV on exit, so the file is normally usable
  the instant it exits; the flat sleep was pure dead time on every turn
  (the stop-side cousin of the removed record-start sleep). It is now an
  adaptive check that returns immediately in the common case and only
  waits — up to a *longer* cap than the old 150 ms — if a slow disk
  flush genuinely needs it, so it is both faster and more robust.
- **The model answer and the follow-up question were spoken one after
  the other.** Their two text-to-speech calls are independent round
  trips to the same provider but were issued serially, so a turn with a
  follow-up question waited through both in sequence. They now run
  concurrently — each still degrading on its own (a failed clip is
  skipped, the turn and the other clip are kept) — which roughly halves
  the speak step whenever there is a follow-up.
- **The "which lesson is next" lookup re-ran a Python process ~4 times
  per turn.** Resolving the current package shells out to
  `english_training_progress.py` (a cold-started interpreter with a long
  timeout) — or, without that script, a directory + JSON scan — and it
  ran on *every* internal state load: once when you press record, once
  when you press stop, then twice more in the post-turn refresh. So a
  single practice turn cold-started Python up to four times for an answer
  that only changes when you complete or add a lesson. This was a large,
  invisible part of the "press record and wait" lag on setups that have
  that script. The result is now memoized per materials-root and day and
  reused across the turn; it is recomputed exactly when it can actually
  change — completing a lesson, adding a lesson, a date rollover, a
  changed materials root, or an explicit Refresh — so correctness is
  unchanged while the redundant process spawns are gone.
- **A normal-length turn tripped a "taking too long" reset and freed the
  record button mid-pipeline.** The webview's processing watchdog fired
  after a flat 45 s and called `setBusy(false)`, but a healthy turn — each
  of transcribe, coach, and speak is bounded host-side at 90 s and runs in
  sequence, and the coach step alone routinely takes 20–40 s — regularly
  exceeds 45 s. So on ordinary turns the watchdog un-busied the record
  button while the host was still working: the UI stopped looking busy and
  a second press could start an overlapping turn. The watchdog is now a
  *no-progress* detector — every stage transition re-arms it, so a long
  but progressing multi-leg turn never trips it — and it fires only after
  100 s with no progress at all (past the per-leg network ceiling, i.e. a
  genuinely wedged pipeline). It no longer touches the busy state: every
  reachable failure already self-recovers with a bounded error that clears
  busy and resets the recorder authoritatively, so the watchdog is now
  purely an advisory status line and can never strand a live turn.

### Changed
- **Record-start is now a visible, staged process.** Instead of one frozen
  "Using Mac local recorder…" line, the host streams the real phase it is
  in — *Resetting the previous recorder…* → *Preparing microphone…* →
  *Starting recorder…* → *Listening… speak now.* — so the wait is legible
  and obviously progressing rather than hung.

## [0.1.35] — 2026-05-17

A runtime-stability pass: every place the practice flow could hang, lose a
good recording, or trap the user with a hot microphone is now closed, and
the coach provider lineup is simplified.

### Fixed
- **No network call had a timeout.** Node's global `fetch` never times out,
  so a stalled network (captive portal, dead VPN, a provider edge holding
  the socket) made the coach / transcribe / TTS step hang forever with no
  self-recovery. All LLM, speech-input, and speech-output HTTP calls now go
  through a bounded fetch (90 s) that surfaces a clear, retryable error.
- **A coach failure threw away a good recording.** A coach hiccup (timeout,
  missing/invalid key, provider 5xx) discarded the already-successful
  recording + transcript and skipped session persistence, forcing a
  re-record. The turn is now kept, the transcript is preserved, the session
  is saved, and you are told to press ↻ to re-analyze without re-recording.
- **A corrupt lesson file degraded silently.** A syntax error in the current
  package's `english-training.json` (e.g. a trailing comma) showed an
  enabled record button over a totally empty lesson with no hint why.
  Missing vs. malformed are now distinguished: record is gated and Source
  Diagnostics shows an error banner naming the JSON parse error.
- **A leftover recorder bricked the record button with the mic still hot.**
  Pressing record now reclaims and kills a stale `ffmpeg` instead of
  throwing "already running" into a dead end — important now that the
  retained webview no longer disposes (and thus no longer reaps it) on hide.
- **The default Mac recorder could trap the user forever.** If the host
  never confirmed start, the timer ran, record stayed locked, and stop was
  inert. A 15 s start watchdog now self-heals into a clear retryable error.
- The record timer could be orphaned (repainting forever) when the
  webview-recorder fallback reached `startTimer` twice; it is now idempotent.
- On any pipeline error a live webview `MediaRecorder` + mic stream was left
  running (hot mic + a zombie recorder that could post a second unsolicited
  take). The error path now tears the webview recorder down without firing
  its `onstop` pipeline, regardless of recorder mode.

### Changed
- The practice cockpit now **retains its context when hidden**. Collapsing
  the view or clicking another sidebar item no longer wipes an in-progress
  session or strands a running native recorder.
- **DeepSeek removed as a coach provider; OpenAI added as a real one.**
  Coach providers are now Gemini (default), Xiaomi MiMo, and OpenAI. The
  OpenAI coach uses the chat-completions JSON endpoint with a configurable
  `englishTraining.openaiCoachModel` (default `gpt-4o`). All DeepSeek
  plumbing — the configure-key command, the status-tree row, the
  `deepseekAnthropicBaseUrl` / `deepseekCoachModel` settings, and the
  provider enum member — is gone. A persisted `coachProvider: "deepseek"`
  is migrated to the Gemini default so it cannot wedge the coach step.

## [0.1.34] — 2026-05-17

Makes the syllable-stress card actually render, and closes the contract loop
so future generated materials can never silently lose it.

### Fixed
- The stress card now shows **which syllable carries the primary stress**
  (e.g. `ac·count·a·BIL·i·ty`). The renderer always supported this, but every
  shipped lesson package omitted `words[].syllables`, so the code path was
  dead and the card fell back to the bare word. All 120 local packages were
  backfilled (2179 specs) from a hand-vetted, mechanically-validated syllable
  lexicon — deterministic, reviewable, no network, no per-run cost. True
  monosyllables and initialisms are correctly left whole.
- Corrected a linguistic error baked into the Card Schema itself: the worked
  `accountability` example taught `ac·COUNT·a·bil·i·ty` (wrong stress). Since
  this is a pronunciation trainer and the schema is read by the generating
  LLM, that example actively taught the wrong word stress. Now
  `ac·count·a·BIL·i·ty`, parallel to `re·spon·si·BIL·i·ty`.

### Changed
- **Card Schema v1.1 → v1.2.** `words[].syllables` is now stated as
  **REQUIRED** for every multi-syllable listed word (the contract previously
  said "RECOMMENDED" in the field doc while `hardRules` said MUST — that
  contradiction is why packages shipped without it). The generation prompt
  now carries a prominent **"Render-critical invariants"** section that maps
  each rule to the card it silently breaks, so any LLM following the prompt
  produces materials this extension can fully render. `materials-guide.ts`
  now interpolates the schema version instead of a hardcoded literal so it
  cannot drift again.
- The `scripts/` maintenance tooling (syllable lexicon + backfill) is kept in
  git but excluded from the published VSIX (dev-only, like `src/`).

## [0.1.33] — 2026-05-17

### Fixed
- The pitch card no longer collapses to a single terminal arrow when a lesson
  package crams several sentences into one thought group. Such a degenerate
  single-group line is now split at sentence boundaries for display: non-final
  sentences take the level "→" continuation tone and the final sentence keeps
  the group's real nucleus, contour, and pause. This reproduces the exact
  →…→…↘ convention every well-formed package already uses, asserts no pitch
  the data did not imply, and is a strict no-op for correctly grouped
  packages (verified: 114/120 reference packages unchanged, only the 6
  single-group packages repaired, no multi-group package altered).

## [0.1.32] — 2026-05-17

A flow-stability and counter-intuitive-design pass over the full practice
loop: record → transcribe → coach → speak → save → drill.

### Fixed
- A speech-output (TTS) failure on the main coached reply no longer discards
  an already-successful transcribe + coach turn. The coaching result is kept
  and only playback is skipped, matching the existing follow-up TTS behaviour.
- The record button now ships disabled with a neutral "Checking setup…"
  status until the first state arrives, closing a window where an early click
  could start recording before setup had been verified.
- Stale turn history, drill state, and reply context are now cleared when the
  active lesson changes, instead of leaking from the previous lesson into the
  new one.
- Pressing stop during the brief native-recorder arming window no longer
  drops the request; it waits for the recorder to start listening.
- The slow-read host is reset after a slow-read failure so a later retry is
  no longer blocked.
- Missing API key errors now name the exact Command Palette command to run
  (for example "English Training: Configure Gemini API Key") instead of a
  vague "run the configure command first".

### Changed
- A deliberate MiniMax speech-output (TTS) choice is no longer silently
  reverted to Gemini on every activation.
- Selecting an unsupported provider value now reports a clear error instead
  of silently doing nothing.
- The drill "Generate" action is disabled with an explanatory hint until the
  core key and a lesson are ready, and a persistent reminder is shown while a
  shadowing example is armed for the next recording.

## [0.1.31] — 2026-05-17

Supersedes the 0.1.30 Marketplace build, which was published from an
incomplete state and is missing the changes below.

### Added
- Added a Reading Card panel that displays prebuilt `daily-card.png`,
  `prosody-detail.png`, `audio/demo.ogg`, stress guide, intonation guide, and
  word-level prosody from local lesson packages.
- Documented the package-generation contract for reading-card assets and
  structured prosody fields so future materials can stay aligned with the VS
  Code surface.
- Added interactive FSI drill choices after a practice result, with Listen,
  Practice, and Skip actions for generated or prebuilt substitution examples.
- Added Xiaomi MiMo as a speech-input (audio understanding) provider and as a
  speech-output (TTS) provider, both reusing the existing MiMo API key over the
  OpenAI-compatible endpoint.
- Added `English Training: Compose Material Prompt with Coach`: type a topic and
  a lesson date, the configured Coach model expands it into a tailored brief,
  and the extension writes one schema-conformant `material-generation-prompt.md`
  you can paste into any LLM. Surfaced as a "Generate training material" panel
  at the bottom of the Practice sidebar and documented in the README and
  Materials Guide.

### Changed
- Removed Azure from the active speech-input route. Gemini is now the default
  transcript-matching path, with OpenAI Realtime as the optional low-latency
  STT route.
- Shadowing checks now use simple transcript-vs-reference matching instead of
  Azure-style pronunciation scoring.
- Consolidated coach providers to Gemini, Xiaomi MiMo, and DeepSeek. Removed
  Kimi entirely; OpenAI and MiniMax remain available for speech input/output
  only. Stale `kimi`, `openai`, or `minimax` coach settings now migrate to
  Gemini automatically.

## [0.1.29] — 2026-05-14

### Added
- Added regression tests for activation, command/manifest drift, provider model
  schema alignment, local materials root detection, recorder microphone
  selection, malformed coaching JSON recovery, TTS speed normalization, and
  audio MIME handling.

### Fixed
- Treat a local materials folder with only `prebuilt/` as a valid bring-your-own
  lesson root, matching the README first-run flow.
- Aligned the MiniMax coach model picker with the package schema, including
  `MiniMax-M2.7-highspeed`.
- Restored the OpenAI TTS fallback voice to the package default `coral`.
- Report missing or unlaunchable `ffmpeg` directly in the native recorder path
  instead of falling through to a misleading microphone-selection error.
- Excluded local regression tests from the packaged VSIX.

## [0.1.28] — 2026-05-11

### Changed
- Removed Gemini 2.5 model choices from the current provider UI. Gemini coach
  and speech input now expose only the current Gemini 3 family, and Gemini TTS
  exposes only `gemini-3.1-flash-tts-preview`.
- Expanded migration so older saved Gemini 2.5 coach, speech-input, or TTS
  settings are lifted to the latest Gemini 3 / 3.1 equivalents automatically.

## [0.1.27] — 2026-05-11

### Changed
- Made Gemini + Azure the core recommended route: Gemini is now the default
  coach and speech-output provider, while Azure remains the default speech-input
  and pronunciation-scoring provider.
- Updated onboarding to require the two core keys (Gemini + Azure) instead of
  suggesting MiniMax or any single AI provider key as enough for the main loop.
- Moved MiniMax, OpenAI, MiMo, Kimi, and DeepSeek into optional fallback
  positions in the Routes & Models panel.

### Fixed
- Added migration for old saved MiniMax default route settings so an upgraded
  install does not keep requiring MiniMax when the intended route is Gemini +
  Azure.

## [0.1.26] — 2026-05-11

### Changed
- Updated Gemini model choices from Google AI Studio / Gemini API docs:
  Gemini coach and Gemini speech input now default to `gemini-3-flash-preview`
  and expose `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, and
  `gemini-3.1-flash-lite-preview` as selectable Gemini 3 family options.
- Kept Gemini speech output on the latest `gemini-3.1-flash-tts-preview` route
  while preserving older 2.5 TTS previews as fallback options.
- Added a small migration for old saved `gemini-2.5-flash` defaults so the
  Routes & Models panel does not keep showing the old Gemini speech-input model
  after upgrading the extension.

## [0.1.25] — 2026-05-11

### Added
- Added OpenAI Realtime as a selectable speech-input provider using
  `gpt-realtime-whisper` over a server-side WebSocket connection in the VS Code
  extension host.
- Added `englishTraining.openaiRealtimeTranscriptionModel` and a command/card
  for `English Training: Use OpenAI Realtime Speech Input`.

### Changed
- The provider UX now presents Azure, OpenAI Realtime, and Gemini as distinct
  speech-input routes: Azure remains the scoring/pronunciation-assessment route,
  while OpenAI Realtime is used for transcript generation.

## [0.1.24] — 2026-05-11

### Added
- Reworked the sidebar provider controls into a single `Routes & Models` panel
  with active route cards, key status, provider switching, and model/region/voice
  configuration entry points.
- Added a `Recommended hybrid` preset for MiniMax coach + Azure speech input +
  MiniMax speech output, keeping `Gemini only` as a one-click route.

### Fixed
- Corrected stale README/changelog provider descriptions from the old
  OpenAI/Gemini/MiMo speech-input era.

## [0.1.23] — 2026-05-11

### Added
- Added Gemini as a speech-input provider. The VS Code recorder can now send
  short practice audio to Gemini audio understanding for JSON transcript
  extraction instead of Azure Fast Transcription.
- Added a `Gemini only` preset/command that switches coach, speech input, and
  speech output to Gemini while keeping Azure available for precise
  Pronunciation Assessment workflows.

## [0.1.22] — 2026-05-11

### Fixed
- Split free-answer coaching from shadowing checks. After generating example
  audio or clicking `Imitate native`, the next recording now carries a
  reference target, and the generated native audio is forced to read that
  reference instead of replaying Azure STT mistakes.
- Shadowing results label the right-hand side as `Reference` / `Example text`
  rather than treating the learner's misrecognized transcript as a new native
  sentence.

## [0.1.21] — 2026-05-11

### Fixed
- Made coach-response parsing tolerant of provider JSON glitches: the extension
  now extracts fenced/embedded JSON, repairs common malformed output, and
  recovers partial coaching fields instead of blocking the practice turn with a
  raw `Could not parse coaching JSON` error.
- Tightened the coach prompt so MiMo/MiniMax-style providers return only compact
  one-line JSON strings with the expected coaching keys.

## [0.1.20] — 2026-05-11

### Fixed
- Guarded invalid `englishTraining.timezone` values so the sidebar falls back
  to `Asia/Shanghai` instead of crashing while loading state.
- Normalized `englishTraining.ttsSpeed` before it reaches the sidebar or TTS
  providers, preventing dirty settings such as `NaN`, `null`, or out-of-range
  numbers from breaking runtime speech generation.
- Cleaned up the webview recorder failure path: empty recordings are rejected
  before transcription, microphone streams are stopped on fallback/error, and
  retrying a failed follow-up reply preserves its prior-turn context.
- `Open Current Task Card` now falls back to the current
  `english-training.json` when a minimal local package does not include
  `telegram-task-card.md`.
- Published the existing OpenAI coach command and `openaiCoachModel` setting in
  the extension manifest so command palette/settings UI match the runtime code.

## [0.1.19] — 2026-05-11

### Added
- **Playback speed chips.** A new Speed row under the record button exposes
  0.6× / 0.8× / 0.9× / 1.0× / 1.2× as one-tap chips, persisting to
  `englishTraining.ttsSpeed` on the workspace. A "Custom" chip appears (and
  shows pressed) when the configured speed is outside the preset list.
- **Slow read.** Both the native version and the coach's follow-up question
  carry a 🐢 Slow read button that resynthesises the same text at 0.7× via the
  configured TTS provider; the audio appears inline next to the source block.
- **Turn breadcrumb.** Replaces the old decorative three-stage stepper with a
  real `Turn N` breadcrumb driven by `turnHistory.length`. Done chips are
  clickable (mouse + keyboard) and scroll to the matching conversation entry.
  Reply turns carry a `REPLY` tag.
- **Voice picker disclosure.** The MiniMax voice row defaults to six favourites
  plus an "Active" slot when the current voice isn't favourited; an
  "All voices ⌄ N" toggle expands to the full grouped catalogue, including
  cloned voices.

### Changed
- **Follow-up audio no longer autoplays.** It still preloads, but the user
  drives playback — the diff and the Quick Fix are now readable before the
  coach starts talking. Focus still moves to the "Answer follow-up →" button
  when playback ends.
- **Conversation history shows your audio for webview-mode turns.** Falls back
  to the local blob URL when the host hasn't shipped a `localAudioUri` field.
- **Result panel scrolls into view** after each `practiceResult` so the new
  diff is visible without manual scrolling.
- **`stopNativeRecording` preserves `pendingPriorTurn` on coach failure** so
  retrying a reply doesn't lose the prior turn context (now matches the
  webview-recorder path).

### Internal
- Practice pipeline modules split out under `src/practice/` (transcribe,
  coach, pronounce, save, tts), with shared helpers in `src/core.ts` and
  type aliases in `src/types.ts`. `src/extension.ts` is now ~3.6k lines.

## [0.1.18] — 2026-05-10

### Added
- **Follow-up question auto TTS.** After each practice round, the configured
  speech-output provider also synthesizes the coach's follow-up question; the
  sidebar embeds the resulting audio inline under the Follow-up card and
  autoplays it so the loop can be driven by ear without re-reading the text.

## [0.1.17] — 2026-05-10

### Changed
- **Speech input replaced with Azure Speech.** The older OpenAI/MiMo speech
  input paths were removed; recording is now transcribed via the Azure
  Fast Transcription REST API (`speechtotext/transcriptions:transcribe`,
  api-version `2025-10-15`). Configure with the new
  `English Training: Configure Azure Speech Key` command, which also prompts
  for `englishTraining.azureSpeechRegion`. Locale is controlled by
  `englishTraining.azureSpeechLocale` (default `en-US`).
- Sidebar **Speech in** selector collapses to a single Azure button; **Keys**
  panel adds an Azure entry; status tree exposes an Azure Speech Key item.
- `audioUnderstandingProvider` enum is reduced to `["azure"]`; default is now
  `azure`.

### Added
- New module `src/practice/pronounce.ts` wraps the Azure Pronunciation
  Assessment endpoint (Word granularity, prosody-on by default). Not yet wired
  to the practice pipeline — reserved for the upcoming multi-turn shadowing
  loop.

### Internal
- Continued the module split started in 0.1.16: the practice pipeline
  (transcribe / coach / TTS / save) is now factored out under `src/practice/`,
  bringing `src/extension.ts` from ~4.1k to ~3.0k lines.

## [0.1.16] — 2026-05-10

### Fixed
- MiniMax chat and TTS defaults now use the mainland `api.minimaxi.com`
  endpoints so resource-pack keys are not rejected as invalid.
- MiniMax TTS error 2049 now includes the active endpoint in the error message.
- Recording now defaults to the macOS local recorder, which selects a local Mac
  microphone and avoids iPhone/Continuity device names.
- Native ffmpeg recording now supports `auto` microphone selection plus optional
  `preferredMicrophoneName` and blocked-device regex settings.

## [0.1.15] — 2026-05-10

### Changed
- Renamed the sidebar reference player to *Example audio* and changed its
  button to `Generate Example`.
- On-demand reference TTS now uses only explicit example fields:
  `clean_tts_text`, `audio_text`, `demo_line`, or `frames[].text` as a fallback.
  Scenario, goal, and other background fields are never read aloud.

## [0.1.14] — 2026-05-10

### Changed
- *Today audio* now generates TTS on demand from the current
  `clean_tts_text` using the configured speech-output provider, then plays it
  from a webview data URI.
- Prebuilt lesson audio files such as `audio/demo.ogg` are no longer required
  for the sidebar reference audio flow.

## [0.1.13] — 2026-05-10

### Changed
- Materials are now local-only in the user-facing extension flow. The Practice
  sidebar and command palette expose a local folder picker instead of GitHub
  source/token configuration.
- Existing `github` materials settings are ignored at runtime; the extension
  always resolves local `prebuilt/` folders.
- Source diagnostics now report local folders and exact local JSON paths only.

## [0.1.12] — 2026-05-10

### Added
- **Source Diagnostics** panel showing the active source mode, local root or
  GitHub URL, lesson count, date range, current package date, and exact current
  `english-training.json` path or URL.
- **Learner Profile** support. The extension reads
  `profile/learner-profile.md` or `profile/learner-profile.json`, shows
  `Profile loaded` in the sidebar/status tree, and passes the profile into the
  coaching prompt.
- Session artifacts now record source diagnostics and learner profile metadata.

## [0.1.11] — 2026-05-10

### Added
- Marketplace icon (128×128 PNG with branded gradient).
- esbuild-based production bundle (`npm run bundle`) — `out/extension.js`
  shrinks from ~150 KB tsc output to ~106 KB minified.
- `npm run typecheck` script kept separate from emit.

### Changed
- Build pipeline split into `typecheck` + `bundle` phases. `vscode:prepublish`
  now runs both.

## [0.1.10] — 2026-05-10

First public Marketplace release.

### Added
- **Onboarding empty state**: a Quick Setup card in the Practice sidebar that
  surfaces missing pieces (source, lessons, AI key) and routes
  each step to the right configure flow.
- **Bring-your-own-materials path**: `English Training: Create Sample Package`
  writes a starter `prebuilt/<date>/english-training.json`. Bootstraps the
  whole `prebuilt/` + `progress/` layout when no root exists yet.
- **Materials guide**: `English Training: Open Materials Guide` opens an
  in-extension reference for the lesson schema and directory layout.
- **120-day progress strip**: heatmap of every dated lesson with completed /
  current / missed / pending states, plus `Day N/total · Week W · Day k/7`
  chips and a streak counter.
- **Practice cockpit visual overhaul**:
  - Sticky record panel with a single-button toggle CTA, pulse animation, VU
    meter canvas, and elapsed timer.
  - Four-stage pipeline progress (Transcribe → Coach → Speak → Save) wired
    through to the practice runner.
  - Three-state imitation/loop stepper (transcript → imitate → reply).
  - Dual-column word-level diff (You said vs Native says) with LCS-based
    alignment tolerant of punctuation and case.
  - Quick-fix card and highlighted follow-up card surfaced above details.

### Changed
- License switched to MIT.
- Publisher field set to `xianwei-zhang` for Marketplace publishing.
- README rewritten with a first-run quick-start path for users without
  pre-existing materials.

## [0.1.1] — [0.1.9]

Pre-public iterations distributed as `.vsix` files only. Highlights:

- VS Code webview practice cockpit decoupled from Hermes/Telegram.
- Multi-provider AI: coach LLMs across MiniMax, MiMo, OpenAI, Gemini, Kimi,
  and DeepSeek; speech input through Azure or Gemini; speech output through
  MiniMax, OpenAI, or Gemini.
- Native ffmpeg AVFoundation fallback for VS Code microphone denial.
- GitHub materials source mode with private-repo PAT support and asset caching
  in VS Code global storage.
- API keys stored in VS Code SecretStorage; never written to settings.json.
