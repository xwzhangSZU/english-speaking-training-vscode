# Changelog

All notable changes to the **English Speaking Training** VS Code extension will
be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Speech input replaced with Azure Speech.** OpenAI / Gemini / MiMo audio
  understanding paths are removed; recording is now transcribed via the Azure
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
  surfaces missing pieces (source, GitHub token, lessons, AI key) and routes
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
- Multi-provider AI: 5 coach LLMs (MiMo, MiniMax, Gemini, Kimi, DeepSeek),
  3 speech-input providers (OpenAI, Gemini, MiMo), 4 TTS providers (OpenAI,
  Gemini, MiMo, MiniMax).
- Native ffmpeg AVFoundation fallback for VS Code microphone denial.
- GitHub materials source mode with private-repo PAT support and asset caching
  in VS Code global storage.
- API keys stored in VS Code SecretStorage; never written to settings.json.
