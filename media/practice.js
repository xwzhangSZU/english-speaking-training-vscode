    const vscode = acquireVsCodeApi();
    let mediaRecorder = null;
    let stream = null;
    let chunks = [];
    let recorderMode = null;
    // True from posting startNativeRecording until the extension confirms
    // ffmpeg is actually up (nativeRecordingStarted) or fails (error). A stop
    // tap in this ~1s window would otherwise tear down a recorder that has
    // not started, yielding "did not produce a usable audio file" + "exited
    // before it could start" double errors and a lost take.
    let nativeStarting = false;
    let state = null;
    let audioCtx = null;
    let analyser = null;
    let analyserSource = null;
    let vuBuffer = null;
    let vuRaf = null;
    let timerHandle = null;
    let recordingStartedAt = 0;
    let pendingPracticeTarget = null;
    let activeRecordingTarget = null;
    let currentExampleText = "";
    let currentDrillSuggestions = [];
    let drillLibrary = [];
    let drillGeneratedLines = [];
    let drillAttempts = {};
    let drillGenerating = false;
    let pendingSlowReadHost = null;
    let localAudioObjectUrl = null;
    // Start pessimistic: the scaffold ships the record button disabled with a
    // neutral "Checking setup…" status, and applySetupGate flips this the
    // first time real state arrives. This closes the pre-first-state window
    // where the button looked pressable and falsely said "Ready to record".
    let recordingBlockedBySetup = true;
    let currentLessonKey = null;
    const STAGES = ["transcribe", "coach", "tts", "save"];

    // Each webview-recorder turn used to mint a fresh object URL for the
    // <audio> preview without ever revoking the previous one, leaking a blob
    // per recording across a long practice session. Revoke the prior one.
    function setLocalAudioSource(src, ownsBlobUrl) {
      const el = $("localAudio");
      if (!el) return;
      if (localAudioObjectUrl) {
        URL.revokeObjectURL(localAudioObjectUrl);
        localAudioObjectUrl = null;
      }
      el.src = src;
      el.hidden = false;
      if (ownsBlobUrl) localAudioObjectUrl = src;
    }
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

    function isRecording() {
      return recorderMode === "native" || (mediaRecorder && mediaRecorder.state === "recording");
    }

    function startVuMeter(mediaStream) {
      try {
        if (!audioCtx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          audioCtx = new Ctx();
        }
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
        analyserSource = audioCtx.createMediaStreamSource(mediaStream);
        analyserSource.connect(analyser);
        vuBuffer = new Uint8Array(analyser.frequencyBinCount);
        drawVu();
      } catch (error) {
        // Silent: VU is best-effort.
      }
    }

    function drawVu() {
      const canvas = $("vu");
      if (!canvas || !analyser || !vuBuffer) return;
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      analyser.getByteFrequencyData(vuBuffer);
      ctx.clearRect(0, 0, w, h);
      const bars = 18;
      const gap = 1;
      const barWidth = Math.max(1, (w - gap * (bars - 1)) / bars);
      for (let i = 0; i < bars; i += 1) {
        const idx = Math.min(vuBuffer.length - 1, Math.floor((i / bars) * vuBuffer.length));
        const value = vuBuffer[idx] / 255;
        const barHeight = Math.max(1.5, value * h);
        const alpha = 0.3 + value * 0.6;
        ctx.fillStyle = "rgba(229, 20, 0, " + alpha.toFixed(2) + ")";
        ctx.fillRect(i * (barWidth + gap), h - barHeight, barWidth, barHeight);
      }
      vuRaf = requestAnimationFrame(drawVu);
    }

    function stopVuMeter() {
      if (vuRaf) cancelAnimationFrame(vuRaf);
      vuRaf = null;
      if (analyserSource) {
        try { analyserSource.disconnect(); } catch (_) {}
      }
      if (analyser) {
        try { analyser.disconnect(); } catch (_) {}
      }
      analyserSource = null;
      analyser = null;
      vuBuffer = null;
      const canvas = $("vu");
      if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }

    function startTimer() {
      recordingStartedAt = Date.now();
      $("timer").textContent = "00:00";
      timerHandle = setInterval(() => {
        const sec = Math.floor((Date.now() - recordingStartedAt) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        $("timer").textContent = m + ":" + s;
      }, 250);
    }

    function stopTimer() {
      if (timerHandle) clearInterval(timerHandle);
      timerHandle = null;
    }

    function resetStages() {
      document.querySelectorAll(".stages li").forEach((li) => li.classList.remove("active", "done"));
    }

    function showStages(visible) {
      $("stages").hidden = !visible;
      if (visible) resetStages();
    }

    function setStage(stage, status) {
      const el = document.querySelector('.stages li[data-stage="' + stage + '"]');
      if (!el) return;
      if (status === "active") {
        el.classList.remove("done");
        el.classList.add("active");
      } else if (status === "done") {
        el.classList.remove("active");
        el.classList.add("done");
      }
    }

    function markAllStagesDone() {
      STAGES.forEach((stage) => setStage(stage, "done"));
    }

    function practiceTarget(referenceText, referenceLabel, followUpQuestion) {
      const text = String(referenceText || "").trim();
      if (!text) return null;
      return {
        mode: "shadow",
        referenceText: text,
        referenceLabel: referenceLabel || "Reference",
        followUpQuestion: String(followUpQuestion || "").trim(),
      };
    }

    function consumePracticeTarget() {
      const target = pendingPracticeTarget;
      pendingPracticeTarget = null;
      return target;
    }

    // First-run guard. The red button looks pressable from the very first
    // render, but a recording made before a Gemini key + a lesson both exist
    // is wasted work — the pipeline only fails *afterwards* with a raw
    // "Missing API key" error. Gate the button on the same readiness signal
    // the onboarding panel uses, and only touch status/button on the
    // not-ready boundary so a normal "Ready ✓"/result/error status produced
    // during a real turn is never clobbered by a coincidental re-render.
    // Single source of truth for "is the practice loop usable yet": a Gemini
    // key plus at least one lesson. Both the record button and the drill
    // generator gate on this so a control can never look pressable while a
    // click would only fail later with a raw "Missing API key" error.
    function setupReady(currentState) {
      const keys = (currentState && currentState.keys) || {};
      const progress = currentState && currentState.progress;
      const coreKeysReady = Boolean(keys.gemini);
      const hasLessons = Boolean(progress && progress.total && progress.total > 0);
      return { ready: coreKeysReady && hasLessons, coreKeysReady, hasLessons };
    }

    function applySetupGate(currentState) {
      // A re-render can land mid-recording (an unrelated refreshAll). Never
      // disable the button or clobber "Listening…" while a take is live —
      // the user still needs to press stop, and a half-finished recording
      // would otherwise be silently abandoned.
      if (isRecording()) return;
      const { ready, coreKeysReady } = setupReady(currentState);
      const btn = $("record");
      if (!ready) {
        recordingBlockedBySetup = true;
        if (btn) btn.disabled = true;
        // Keep a real, actionable error visible if one is already showing;
        // otherwise replace the misleading hardcoded "Ready to record".
        const statusEl = $("status");
        if (!(statusEl && statusEl.classList.contains("error"))) {
          setStatus(
            !coreKeysReady
              ? "Add a Gemini API key in Quick setup above to start recording."
              : "Create your first lesson in Quick setup above to start recording.",
          );
        }
        return;
      }
      if (recordingBlockedBySetup) {
        recordingBlockedBySetup = false;
        // setBusy() owns the button while a turn is processing; only the
        // setup gate could have disabled it on this path, so it is safe to
        // release here unless a pipeline is mid-flight.
        if (btn && !btn.classList.contains("busy")) btn.disabled = false;
        setStatus("Ready to record");
      }
    }

    // After "Complete" advances to the next package, the previous lesson's
    // conversation, generated drills and attempt counts are stale: the loop
    // buttons would otherwise record against old material and the drill
    // workbench would mix yesterday's AI lines into today's set. Reset that
    // session state when (and only when) the package actually changes. The
    // first render just adopts the key — a fresh webview already starts clean,
    // and an in-lesson refresh (e.g. after a turn) keeps the same key so the
    // history the user just built is preserved.
    function applyLessonReset(nextInfo) {
      const key = String((nextInfo && nextInfo.package_date) || "");
      if (currentLessonKey === null) {
        currentLessonKey = key;
        return;
      }
      if (key === currentLessonKey) return;
      currentLessonKey = key;
      turnHistory = [];
      lastTurn = null;
      pendingReplyContext = null;
      pendingPracticeTarget = null;
      drillGeneratedLines = [];
      drillAttempts = {};
      vscode.postMessage({ type: "clearReplyContext" });
      const resultPanel = $("result");
      if (resultPanel) resultPanel.hidden = true;
      renderTurnHistory();
    }

    function renderState(nextState) {
      state = nextState;
      const next = state.next || {};
      const training = state.training || {};
      const drill = state.drill || {};
      const settings = state.settings || {};
      const assets = next.assets || {};
      const todayAudioText = training.tts_example_text || training.clean_tts_text || training.audio_text || training.demo_line || "";
      currentExampleText = todayAudioText;
      renderOnboarding(state);
      applySetupGate(state);
      applyLessonReset(next);
      renderDayStrip({ progress: state.progress, next });
      renderProgress(state.progress);
      renderSourceDiagnostics(state.sourceDiagnostics);
      renderLearnerProfile(state.learnerProfile);
      const weekTag = state.progress && state.progress.weekIndex
        ? "Week " + state.progress.weekIndex + " · Day " + state.progress.dayInWeek + "/" + (state.progress.weekTotalDays || 7)
        : "";
      renderTodayHero({ next, training, settings, assets, todayAudioText, weekTag });
      renderReadingCard(training, assets);
      renderDrillPanel();
      $("sessionLog").innerHTML = `
        <h3>Session Log</h3>
        ${recentSessions(state.recentSessions || [])}
      `;
      $("source").innerHTML = `
        <span class="chip">${esc(state.source || "local")}</span>
        ${state.sourceLabel ? '<span class="chip">' + esc(shortSourceLabel(state.sourceLabel)) + '</span>' : ''}
      `;
      renderProviderPanel(settings, state.keys || {});
      renderMinimaxVoicePicker(settings);
      renderSpeedChips(settings);
    }

    const SPEED_OPTIONS = [0.6, 0.8, 0.9, 1.0, 1.2];

    function renderSpeedChips(settings) {
      const chips = $("speedChips");
      if (!chips) return;
      const current = Number((settings && settings.ttsSpeed) ?? 0.9);
      const hasPresetMatch = SPEED_OPTIONS.some((speed) => Math.abs(speed - current) < 0.01);
      const fragments = SPEED_OPTIONS.map((speed) => {
        const pressed = !hasPresetMatch ? false : Math.abs(speed - current) < 0.01;
        const label = (speed.toFixed(1) + "×").replace(".0", "");
        return '<button type="button" class="speed-chip" data-speed="' + speed + '" aria-pressed="' + (pressed ? "true" : "false") + '">' + esc(label) + '</button>';
      });
      if (!hasPresetMatch && Number.isFinite(current) && current > 0) {
        const labelText = Number.isInteger(current)
          ? String(current)
          : current.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
        const label = labelText + "×";
        fragments.push('<button type="button" class="speed-chip" data-speed="' + current + '" aria-pressed="true" title="Custom speed from settings.json">' + esc(label) + '</button>');
      }
      chips.innerHTML = fragments.join("");
      chips.querySelectorAll("button[data-speed]").forEach((button) => {
        button.addEventListener("click", () => {
          const value = Number(button.dataset.speed);
          if (Number.isFinite(value) && value > 0) {
            vscode.postMessage({ type: "setTtsSpeed", value });
          }
        });
      });
    }

    const MINIMAX_VOICE_OPTIONS = [
      { group: "Female (US)", id: "English_CalmWoman", label: "Calm Woman", favorite: true },
      { group: "Female (US)", id: "English_Upbeat_Woman", label: "Upbeat Woman" },
      { group: "Female (US)", id: "English_AttractiveGirl", label: "Attractive" },
      { group: "Female (US)", id: "English_Kind-heartedGirl", label: "Kind-Hearted" },
      { group: "Female (US)", id: "English_FriendlyNeighbor", label: "Friendly Neighbor" },
      { group: "Female (US)", id: "English_SereneWoman", label: "Serene" },
      { group: "Female (US)", id: "English_radiant_girl", label: "Radiant" },
      { group: "Female (US)", id: "English_nursery_teacher_vv2", label: "Nursery Teacher" },
      { group: "Female (UK)", id: "English_Graceful_Lady", label: "Graceful Lady", favorite: true },
      { group: "Female (UK)", id: "English_compelling_lady1", label: "Compelling Lady" },
      { group: "Male (US)", id: "English_Trustworth_Man", label: "Trustworthy", favorite: true },
      { group: "Male (US)", id: "English_Diligent_Man", label: "Diligent" },
      { group: "Male (US)", id: "English_Gentle-voiced_man", label: "Gentle-voiced" },
      { group: "Male (US)", id: "English_FriendlyPerson", label: "Friendly Guy" },
      { group: "Male (US)", id: "English_GentleTeacher", label: "Gentle Teacher" },
      { group: "Male (US)", id: "English_engaging_instructor_vv2", label: "Engaging Instructor", favorite: true },
      { group: "Male (US)", id: "English_magnetic_voiced_man", label: "Magnetic Voice" },
      { group: "Male (UK)", id: "English_expressive_narrator", label: "Expressive Narrator", favorite: true },
      { group: "Male (UK)", id: "English_Magnetic_Male_2", label: "Magnetic Man" },
      { group: "Male (AU)", id: "English_Aussie_Bloke", label: "Aussie Bloke", favorite: true },
      { group: "Cloned (Turbo)", id: "anne_v001", label: "Anne (clone)", cloned: true },
      { group: "Cloned (Turbo)", id: "julianne_v004", label: "Julianne (clone)", cloned: true },
      { group: "Cloned (Turbo)", id: "marylouise_v004", label: "Mary Louise (clone)", cloned: true },
      { group: "Cloned (Turbo)", id: "audie_v005", label: "Audie (clone)", cloned: true },
    ];

    let voicePickerExpanded = false;

    const PROVIDER_LABELS = {
      minimax: "MiniMax",
      mimo: "MiMo",
      openai: "OpenAI",
      gemini: "Gemini",
      deepseek: "DeepSeek"
    };

    const PROVIDER_ROUTES = {
      coachProvider: [
        { value: "gemini", label: "Gemini", note: "default coach", modelSetting: "geminiCoachModel" },
        { value: "mimo", label: "MiMo", note: "Xiaomi Token Plan", modelSetting: "mimoCoachModel" },
        { value: "deepseek", label: "DeepSeek", note: "reasoning alternate", modelSetting: "deepseekCoachModel" },
      ],
      audioUnderstandingProvider: [
        { value: "gemini", label: "Gemini", note: "default STT match", modelSetting: "geminiAudioUnderstandingModel" },
        { value: "openai", label: "OpenAI Realtime", note: "low-latency STT", modelSetting: "openaiRealtimeTranscriptionModel" },
        { value: "mimo", label: "MiMo", note: "Xiaomi audio understanding" },
      ],
      ttsProvider: [
        { value: "gemini", label: "Gemini", note: "default TTS", modelSetting: "geminiTtsModel", extraSetting: "geminiTtsVoice", extraLabel: "Voice" },
        { value: "minimax", label: "MiniMax", note: "optional fallback", modelSetting: "minimaxTtsModel" },
        { value: "openai", label: "OpenAI", note: "OpenAI voices", modelSetting: "openaiTtsModel", extraSetting: "openaiTtsVoice", extraLabel: "Voice" },
        { value: "mimo", label: "MiMo", note: "Xiaomi voices" },
      ],
    };

    function providerLabel(name) {
      return PROVIDER_LABELS[name] || name;
    }

    function providerModelSummary(setting, option, settings) {
      if (!settings) return "";
      if (!option.modelSetting) return "";
      const model = settings[option.modelSetting] || "";
      const extra = option.extraSetting ? settings[option.extraSetting] || "" : "";
      if (extra) {
        return esc(model) + " · " + esc(extra);
      }
      return esc(model);
    }

    function providerCardHtml(setting, option, settings, keys) {
      const active = settings && settings[setting] === option.value;
      const hasKey = keys && keys[option.value];
      const modelText = providerModelSummary(setting, option, settings);
      const keyBadgeClass = hasKey ? "provider-badge" : "provider-badge missing";
      const routeBadge = active
        ? '<span class="provider-badge active">active</span>'
        : '<span class="' + keyBadgeClass + '">' + (hasKey ? "key" : "missing") + '</span>';
      const useButton = active
        ? '<button class="secondary" disabled>Active</button>'
        : '<button class="secondary" data-provider-setting="' + esc(setting) + '" data-provider-value="' + esc(option.value) + '">Use</button>';
      const modelButton = option.modelSetting
        ? '<button class="secondary" data-config-setting="' + esc(option.modelSetting) + '">' + esc(option.modelLabel || "Model") + '</button>'
        : '';
      const extraButton = option.extraSetting
        ? '<button class="secondary" data-config-setting="' + esc(option.extraSetting) + '">' + esc(option.extraLabel || "Locale") + '</button>'
        : '';
      return [
        '<div class="provider-card ' + (active ? "active" : "") + '">',
          '<div class="provider-card-top">',
            '<div><div class="provider-name">' + esc(option.label) + '</div><div class="provider-note">' + esc(option.note || "") + '</div></div>',
            routeBadge,
          '</div>',
          modelText ? '<div class="provider-model">' + modelText + '</div>' : '',
          '<div class="provider-card-actions">',
            useButton,
            '<button class="secondary" data-key="' + esc(option.value) + '">' + (hasKey ? "Key saved" : "Add key") + '</button>',
            modelButton,
            extraButton,
          '</div>',
        '</div>',
      ].join("");
    }

    function providerRoleHtml(title, setting, settings, keys) {
      const options = PROVIDER_ROUTES[setting] || [];
      const activeValue = settings && settings[setting];
      const activeOption = options.find((option) => option.value === activeValue);
      const current = activeOption ? activeOption.label : providerLabel(activeValue || "");
      return [
        '<div class="provider-role">',
          '<div class="provider-role-head"><span class="label">' + esc(title) + '</span><span class="provider-role-current">' + esc(current) + '</span></div>',
          '<div class="provider-grid">',
            options.map((option) => providerCardHtml(setting, option, settings, keys)).join(""),
          '</div>',
        '</div>',
      ].join("");
    }

    function routeSummaryHtml(label, setting, settings) {
      const value = settings && settings[setting];
      const options = PROVIDER_ROUTES[setting] || [];
      const activeOption = options.find((option) => option.value === value);
      const name = activeOption ? activeOption.label : providerLabel(value || "");
      return '<div class="route-summary-item"><span>' + esc(label) + '</span><strong>' + esc(name) + '</strong></div>';
    }

    function keyStripHtml(keys) {
      return '<div class="key-strip">' + ["gemini", "openai", "minimax", "mimo", "deepseek"].map((name) => {
        const saved = keys && keys[name];
        return '<button class="key-pill ' + (saved ? "saved" : "") + '" data-key="' + esc(name) + '">' + esc(providerLabel(name)) + ': ' + (saved ? "saved" : "missing") + '</button>';
      }).join("") + '</div>';
    }

    function renderProviderPanel(settings, keys) {
      const panel = $("providersPanel");
      if (!panel) return;
      panel.innerHTML = [
        '<h3>Routes & Models</h3>',
        '<div class="route-summary">',
          routeSummaryHtml("Coach", "coachProvider", settings),
          routeSummaryHtml("Speech in", "audioUnderstandingProvider", settings),
          routeSummaryHtml("Speech out", "ttsProvider", settings),
        '</div>',
        '<div class="provider-presets">',
          '<button class="secondary" id="useGeminiOnly" title="Set coach, speech input, and speech output all to Gemini">Reset to all-Gemini route</button>',
        '</div>',
        providerRoleHtml("Coach", "coachProvider", settings, keys),
        providerRoleHtml("Speech in", "audioUnderstandingProvider", settings, keys),
        providerRoleHtml("Speech out", "ttsProvider", settings, keys),
        '<div class="field" id="minimaxVoiceField" hidden><span class="label">MiniMax voice</span><div class="row" id="minimaxVoicePicker"></div></div>',
        keyStripHtml(keys),
      ].join("");
    }

    function voiceChipHtml(opt, current) {
      const active = opt.id === current ? " active" : "";
      const cloned = opt.cloned ? ' data-voice-cloned="1"' : "";
      const tag = opt.cloned ? '<span class="voice-tag" title="Cloned voice — pinned to Turbo">clone</span>' : '';
      return '<button class="secondary' + active + '" data-voice-id="' + esc(opt.id) + '"' + cloned + ' title="' + esc(opt.id) + '">' + esc(opt.label) + tag + '</button>';
    }

    function renderMinimaxVoicePicker(settings) {
      const field = $("minimaxVoiceField");
      const picker = $("minimaxVoicePicker");
      if (!field || !picker) return;
      const ttsProvider = settings && settings.ttsProvider;
      if (ttsProvider !== "minimax") {
        field.hidden = true;
        picker.innerHTML = "";
        return;
      }
      field.hidden = false;
      const current = (settings && settings.minimaxTtsVoiceId) || "";
      const fragments = [];

      if (voicePickerExpanded) {
        const groups = new Map();
        for (const option of MINIMAX_VOICE_OPTIONS) {
          if (!groups.has(option.group)) groups.set(option.group, []);
          groups.get(option.group).push(option);
        }
        for (const [group, options] of groups) {
          fragments.push('<span class="voice-group-label">' + esc(group) + '</span>');
          for (const opt of options) {
            fragments.push(voiceChipHtml(opt, current));
          }
        }
        fragments.push('<button type="button" class="voice-toggle" data-voice-toggle="collapse" title="Show favorites only">Hide ⌃</button>');
      } else {
        const favorites = MINIMAX_VOICE_OPTIONS.filter((opt) => opt.favorite);
        const currentIsFavorite = favorites.some((opt) => opt.id === current);
        for (const opt of favorites) {
          fragments.push(voiceChipHtml(opt, current));
        }
        if (current && !currentIsFavorite) {
          const activeOpt = MINIMAX_VOICE_OPTIONS.find((opt) => opt.id === current);
          if (activeOpt) {
            fragments.push('<span class="voice-group-label">Active</span>');
            fragments.push(voiceChipHtml(activeOpt, current));
          }
        }
        const hiddenCount = MINIMAX_VOICE_OPTIONS.length - favorites.length;
        fragments.push('<button type="button" class="voice-toggle" data-voice-toggle="expand" title="Show all voices">All voices ⌄ <span class="voice-toggle-count">' + hiddenCount + '</span></button>');
      }

      picker.innerHTML = fragments.join("");
      picker.querySelectorAll("button[data-voice-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const voiceId = button.dataset.voiceId;
          const cloned = button.dataset.voiceCloned === "1";
          vscode.postMessage({ type: "setMinimaxVoice", voiceId, pinTurbo: cloned });
        });
      });
      picker.querySelectorAll("button[data-voice-toggle]").forEach((button) => {
        button.addEventListener("click", () => {
          voicePickerExpanded = button.dataset.voiceToggle === "expand";
          renderMinimaxVoicePicker((state && state.settings) || settings);
        });
      });
    }

    function renderOnboarding(currentState) {
      const panel = $("onboarding");
      if (!panel) return;
      const keys = (currentState && currentState.keys) || {};
      const coreKeysReady = Boolean(keys.gemini);
      const source = currentState && currentState.source;
      const sourceLabel = currentState && currentState.sourceLabel;
      const sourceConfigured = Boolean(sourceLabel) || source === "local";
      const progress = currentState && currentState.progress;
      const hasLessons = Boolean(progress && progress.total && progress.total > 0);
      const allDone = coreKeysReady && sourceConfigured && hasLessons;
      if (allDone) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      const sourceStep = sourceConfigured
        ? { state: "done", title: "Source connected", hint: "Local prebuilt folder", action: "" }
        : { state: "active", title: "Pick local folder", hint: "Choose a folder containing prebuilt/", action: '<button class="primary" data-onboard="source">Choose folder</button>' };
      const lessonStep = hasLessons
        ? { state: "done", title: "Lesson library ready", hint: progress.total + " lesson" + (progress.total === 1 ? "" : "s") + " in prebuilt/", action: "" }
        : { state: "active", title: "Create your first lesson", hint: "Writes a starter prebuilt/<today>/english-training.json", action: '<button class="primary" data-onboard="create-sample">Create sample</button>' };
      const keyStep = coreKeysReady
        ? { state: "done", title: "Gemini ready", hint: "Core practice route is fully configured", action: "" }
        : { state: "active", title: "Connect Gemini", hint: "Gemini handles coach, speech input, and speech output", action: '<button class="primary" data-onboard="provider-key">Set up</button>' };
      const steps = [sourceStep, lessonStep, keyStep].filter(Boolean);
      const renderedSteps = steps.map((step, idx) => {
        const mark = step.state === "done" ? "✓" : String(idx + 1);
        return `
          <li class="onboarding-step ${step.state}">
            <span class="step-mark">${mark}</span>
            <span class="step-body"><strong>${esc(step.title)}</strong><span>${esc(step.hint)}</span></span>
            ${step.action || '<span></span>'}
          </li>
        `;
      }).join("");
      panel.hidden = false;
      panel.innerHTML = `
        <p class="onboarding-title">Quick setup</p>
        <p class="onboarding-sub">Two minutes to your first practice loop.</p>
        <ol class="onboarding-steps">${renderedSteps}</ol>
      `;
    }

    function renderSourceDiagnostics(diagnostics) {
      const panel = $("diagnostics");
      if (!panel) return;
      const value = diagnostics || {};
      const lessonText = (value.lessonCount || 0) + " lesson" + (value.lessonCount === 1 ? "" : "s")
        + (value.dateRange ? " · " + value.dateRange : "");
      const rows = [
        ["Mode", value.mode || "unknown"],
        ["Materials root", value.root || ""],
        ["Configured source", value.configuredRoot || ""],
        ["Lessons", lessonText],
        ["Current package", value.currentPackageDate || ""],
        ["Current JSON", value.currentJson || ""],
        ["Package folder", value.packageDir || ""],
      ].filter((row) => row[1]);
      panel.innerHTML = `
        <h3>Source Diagnostics</h3>
        <div class="chips">
          <span class="chip">${esc(value.mode || "unknown")} source</span>
          <span class="chip">${esc(lessonText)}</span>
        </div>
        <div class="kv-list">
          ${rows.map(([label, text]) => diagnosticRow(label, text)).join("")}
        </div>
        <div class="materials-actions">
          <button class="secondary" data-onboard="generate-next">＋ Generate next package</button>
          <button class="secondary" data-onboard="materials-guide">Materials guide</button>
        </div>
      `;
    }

    function renderLearnerProfile(profile) {
      const panel = $("learnerProfile");
      if (!panel) return;
      const value = profile || {};
      const loaded = Boolean(value.loaded);
      panel.innerHTML = `
        <h3>Learner Profile</h3>
        <div class="chips">
          <span class="chip">${loaded ? "Profile loaded" : "Profile missing"}</span>
          <span class="chip">${esc(value.format || "missing")}</span>
        </div>
        <div class="kv-list">
          ${diagnosticRow("Source", value.source || "profile/learner-profile.md")}
          ${value.summary ? diagnosticRow(loaded ? "Summary" : "Next step", value.summary) : ""}
        </div>
      `;
    }

    function diagnosticRow(label, value) {
      return `
        <div class="kv-row">
          <span class="label">${esc(label)}</span>
          <code title="${esc(value)}">${esc(value)}</code>
        </div>
      `;
    }

    function renderProgress(progress) {
      const panel = $("progress");
      if (!panel) return;
      if (!progress || !Array.isArray(progress.cells) || progress.cells.length === 0) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      const total = progress.total || progress.cells.length;
      const dayLabel = progress.currentIndex
        ? "Day " + progress.currentIndex + " / " + total
        : (progress.completedCount || 0) + " / " + total + " completed";
      const weekLabel = progress.weekIndex
        ? "Week " + progress.weekIndex + " · " + (progress.weekCompletedDays || 0) + "/" + (progress.weekTotalDays || 7)
        : "";
      const streakLabel = progress.streak && progress.streak > 0
        ? "🔥 " + progress.streak + "-day streak"
        : "";
      const cells = progress.cells.map((cell) => {
        const status = cell && cell.status ? cell.status : "pending";
        const date = cell && cell.date ? cell.date : "";
        return '<div class="heatmap-cell ' + esc(status) + '" title="' + esc(date) + ' · ' + esc(status) + '"></div>';
      }).join("");
      panel.innerHTML = `
        <div class="progress-meta">
          <span class="progress-chip primary">${esc(dayLabel)}</span>
          ${weekLabel ? '<span class="progress-chip">' + esc(weekLabel) + '</span>' : ''}
          ${streakLabel ? '<span class="progress-chip streak">' + esc(streakLabel) + '</span>' : ''}
        </div>
        <div class="heatmap" role="img" aria-label="${esc(dayLabel)}">${cells}</div>
        <div class="heatmap-legend" aria-hidden="true">
          <span><i class="lg-completed"></i>done</span>
          <span><i class="lg-current"></i>today</span>
          <span><i class="lg-missed"></i>missed</span>
          <span><i class="lg-pending"></i>upcoming</span>
        </div>
      `;
    }

    function renderDayStrip(ctx) {
      const strip = $("dayStrip");
      if (!strip) return;
      const progress = (ctx && ctx.progress) || null;
      const next = (ctx && ctx.next) || {};
      if (!progress || !Array.isArray(progress.cells) || progress.cells.length === 0) {
        strip.hidden = true;
        strip.innerHTML = "";
        return;
      }
      const total = progress.total || progress.cells.length;
      const dayLabel = progress.currentIndex
        ? "Day " + progress.currentIndex + " / " + total
        : (progress.completedCount || 0) + " / " + total + " done";
      const weekLabel = progress.weekIndex
        ? "Week " + progress.weekIndex + " · " + (progress.weekCompletedDays || 0) + "/" + (progress.weekTotalDays || 7)
        : "";
      const streakLabel = progress.streak && progress.streak > 0 ? "🔥 " + progress.streak : "";
      const chips = [
        next.package_date ? '<span class="ds-chip ds-date">' + esc(next.package_date) + "</span>" : "",
        '<span class="ds-chip ds-primary">' + esc(dayLabel) + "</span>",
        weekLabel ? '<span class="ds-chip">' + esc(weekLabel) + "</span>" : "",
        streakLabel ? '<span class="ds-chip ds-streak">' + esc(streakLabel) + "</span>" : "",
      ].filter(Boolean).join("");
      strip.hidden = false;
      strip.innerHTML = '<div class="ds-row">' + chips + "</div>";
    }

    function renderTodayHero(ctx) {
      const host = $("task");
      if (!host) return;
      const next = ctx.next || {};
      const training = ctx.training || {};
      const settings = ctx.settings || {};
      const assets = ctx.assets || {};
      const line = ctx.todayAudioText || "";
      const weekTag = ctx.weekTag || "";
      const goal = training.goal || next.goal || next.completion_label || "Today's practice";
      const scenario = training.scenario || next.scenario || "";
      const setup = training.chinese_setup || next.chinese_setup || "";
      host.innerHTML = `
        <div class="today-head">
          <span class="today-eyebrow">🎯 TODAY${next.package_date ? " · " + esc(next.package_date) : ""}${weekTag ? " · " + esc(weekTag) : ""}</span>
          <span class="chip">${esc(next.training_type || "practice")}</span>
        </div>
        <h2 class="today-goal">${esc(goal)}</h2>
        ${scenario ? '<p class="today-scenario">' + esc(scenario) + '</p>' : ''}
        ${setup ? '<p class="today-setup muted">' + esc(setup) + '</p>' : ''}
        ${prosodyLineBlockHtml(training, line)}
        <div class="today-actions">
          <button data-hero-practice="1" ${line ? "" : "disabled"}>🎙 Practice this line</button>
          <button class="secondary" data-action="today-tts" ${line ? "" : "disabled"}>🔊 Generate audio</button>
          <span class="muted" id="todayTtsStatus">Reads example only, with ${esc(settings.ttsProvider || "gemini")}</span>
        </div>
        <div class="today-audio">
          ${prebuiltDemoAudio(assets)}
          <audio id="todayAudio" controls hidden></audio>
        </div>
        <details class="result-details today-frames">
          <summary>Frames &amp; plain text</summary>
          <div class="field"><span class="label">Frames</span>${frames(training.frames)}</div>
          <div class="field"><span class="label">Example text</span><p class="text">${esc(line)}</p></div>
        </details>
      `;
    }

    function normProsodyWord(value) {
      return String(value || "").toLowerCase().replace(/[^a-z0-9']+/g, "");
    }

    // A well-formed package splits a multi-sentence line into one thought group
    // per idea (card-schema: "Split the sentence into thought groups"). A few
    // early packages instead crammed several sentences into ONE group with a
    // single terminal contour, so the pitch card showed just one arrow at the
    // very end and looked broken. When we receive exactly that shape — one
    // group whose text is several sentences — split it at sentence boundaries
    // for display: non-final sentences take the level "→" continuation tone,
    // the final sentence keeps the group's real nucleus + contour + pause.
    // This reproduces the →…→…↘ convention every well-formed package already
    // uses; it asserts no pitch the data didn't imply (non-final sentences are
    // continuation by default) and is a no-op for correct multi-group packages.
    function expandDegenerateProsodyGroups(groups) {
      if (!Array.isArray(groups) || groups.length !== 1) return groups;
      const only = groups[0] || {};
      const parts = String(only.text || "").match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [];
      const sentences = parts.map((s) => s.trim()).filter(Boolean);
      if (sentences.length < 2) return groups;
      const baseId = only.id != null ? only.id : 1;
      return sentences.map((sentence, i) => {
        const isLast = i === sentences.length - 1;
        return {
          id: baseId, // keep the words[] → group lookup intact
          text: sentence,
          nucleus: isLast ? only.nucleus : "",
          contour: isLast ? (only.contour || "→") : "→",
          pause_after: isLast ? (only.pause_after || "final") : "short",
        };
      });
    }

    function contourClass(arrow) {
      const a = String(arrow || "");
      if (a.indexOf("↗") >= 0 || /ris/i.test(a)) return "rise";
      if (a.indexOf("↘") >= 0 || /fall/i.test(a)) return "fall";
      if (a.indexOf("↑") >= 0) return "rise";
      if (a.indexOf("↓") >= 0) return "fall";
      return "level";
    }

    function contourGlyph(arrow) {
      const cls = contourClass(arrow);
      if (cls === "rise") return "↗";
      if (cls === "fall") return "↘";
      return "→";
    }

    function pauseGlyph(pause) {
      const p = String(pause || "").toLowerCase();
      if (p.indexOf("final") >= 0) return "‖";
      if (p.indexOf("long") >= 0) return "‖";
      if (!p || p === "none") return "";
      return "·";
    }

    // "ac·COUNT·a·bil·i·ty" -> [{seg:"ac",stress:false}, {seg:"COUNT",stress:true}, ...]
    // Returns null when there is no usable multi-syllable split so the caller
    // falls back to the original whole-word rendering (old cards, monosyllables).
    function splitSyllableSpec(spec) {
      const parts = String(spec || "").split("·").filter((s) => s.length);
      if (parts.length < 2) return null;
      return parts.map((seg) => {
        const letters = seg.replace(/[^A-Za-z]/g, "");
        const stress = letters.length > 0 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
        return { seg, stress };
      });
    }

    function prosodyWordSpan(token, info, isNucleus, toneArrow) {
      const cls = isNucleus
        ? "nucleus"
        : (info ? prosodyStressClass(String(info.stress || "").toLowerCase()) : "neutral");
      const arrow = (isNucleus ? toneArrow : (info && info.arrow)) || "";
      const arrowHtml = arrow ? '<sup class="pw-arrow ' + contourClass(arrow) + '">' + esc(contourGlyph(arrow)) + '</sup>' : '';
      const title = info
        ? [info.stress ? "Stress: " + info.stress : "", info.pitch_role ? "Pitch: " + info.pitch_role : "", arrow ? "Tone: " + arrow : ""].filter(Boolean).join(" | ")
        : (isNucleus ? "Nucleus" : "");
      const titleAttr = title ? ' title="' + esc(title) + '"' : '';
      const syllables = info && splitSyllableSpec(info.syllables);
      if (syllables) {
        // Mark the stressed syllable with the word's prominence (so the legend
        // still holds), dim the rest. aria-label keeps the plain word for SR.
        const inner = syllables.map((s, i) => {
          const sepHtml = i > 0 ? '<span class="pw-syl-sep" aria-hidden="true">·</span>' : '';
          const sylCls = s.stress ? "pw-syl pw-" + cls : "pw-syl pw-syl-weak";
          return sepHtml + '<span class="' + sylCls + '">' + esc(s.seg) + '</span>';
        }).join("");
        return '<span class="pw pw-syllabified" aria-label="' + esc(token) + '"' + titleAttr + '>' +
          '<span aria-hidden="true">' + inner + '</span>' + arrowHtml + '</span>';
      }
      return '<span class="pw pw-' + cls + '"' + titleAttr + '>' + esc(token) + arrowHtml + '</span>';
    }

    function prosodyGroupLineHtml(groups, words) {
      const wordsByGroup = new Map();
      (Array.isArray(words) ? words : []).forEach((word) => {
        const key = String(word && word.group != null ? word.group : "all");
        if (!wordsByGroup.has(key)) wordsByGroup.set(key, new Map());
        const norm = normProsodyWord(word && word.text);
        if (norm) wordsByGroup.get(key).set(norm, word);
      });
      const segments = groups.map((group, index) => {
        const id = String(group && group.id != null ? group.id : index + 1);
        const lookup = wordsByGroup.get(id) || wordsByGroup.get("all") || new Map();
        const nucleusNorm = normProsodyWord(group && group.nucleus);
        const tokens = String((group && group.text) || "").split(/\s+/).filter(Boolean);
        const wordHtml = tokens.map((token) => {
          const norm = normProsodyWord(token);
          const isNucleus = Boolean(norm) && norm === nucleusNorm;
          return prosodyWordSpan(token, lookup.get(norm), isNucleus, group && group.contour);
        }).join(" ");
        const pause = pauseGlyph(group && group.pause_after);
        const breakHtml = '<span class="pg-break">' +
          '<b class="pg-tone ' + contourClass(group && group.contour) + '">' + esc(contourGlyph(group && group.contour)) + '</b>' +
          (pause ? '<span class="pg-pause" title="Pause: ' + esc((group && group.pause_after) || "") + '">' + esc(pause) + '</span>' : '') +
          '</span>';
        return '<span class="pg">' + wordHtml + '</span>' + (index < groups.length - 1 || pause ? breakHtml : '');
      }).join(" ");
      return '<p class="prosody-line">' + segments + '</p>';
    }

    function prosodyContourRailHtml(groups) {
      if (!groups.length) return "";
      const tiles = groups.map((group, index) => {
        const cls = contourClass(group && group.contour);
        const nucleus = String((group && group.nucleus) || "").replace(/[.,;:!?]+$/, "");
        return '<div class="contour-tile">' +
          '<span class="ct-arrow ct-' + cls + '">' + esc(contourGlyph(group && group.contour)) + '</span>' +
          '<span class="ct-nucleus">' + esc(nucleus || ("Grp " + (index + 1))) + '</span>' +
          '</div>';
      }).join("");
      return '<div class="contour-rail" aria-label="Sentence melody">' + tiles + '</div>';
    }

    function prosodyGuideFallbackHtml(training, line) {
      const stressGuide = String(training.stress_guide || "").trim();
      const intonationGuide = String(training.intonation_guide || "").trim();
      if (!stressGuide && !intonationGuide && !line) return "";
      let lineHtml = "";
      if (stressGuide) {
        const tokens = stressGuide.split(/\s+/).filter(Boolean);
        lineHtml = '<p class="prosody-line">' + tokens.map((raw) => {
          const stressed = raw.indexOf("ˈ") >= 0 || /[A-Z]{2,}/.test(raw.replace(/[^A-Za-z]/g, ""));
          const clean = raw.replace(/ˈ/g, "");
          return '<span class="pw pw-' + (stressed ? "support" : "neutral") + '">' + esc(clean) + '</span>';
        }).join(" ") + '</p>';
      } else if (line) {
        lineHtml = '<p class="prosody-line">' + esc(line) + '</p>';
      }
      let rail = "";
      if (intonationGuide) {
        const segs = intonationGuide.split("|").map((seg) => seg.trim()).filter(Boolean);
        rail = '<div class="contour-rail" aria-label="Sentence melody">' + segs.map((seg) => {
          const cls = contourClass(seg);
          const label = seg.replace(/[→↘↗↑↓]/g, "").trim().split(/\s+/).slice(-1)[0] || "";
          return '<div class="contour-tile"><span class="ct-arrow ct-' + cls + '">' + esc(contourGlyph(seg)) + '</span><span class="ct-nucleus">' + esc(label) + '</span></div>';
        }).join("") + '</div>';
      }
      return lineHtml + rail;
    }

    function prosodyLegendHtml() {
      return '<div class="prosody-legend" aria-hidden="true">' +
        '<span><i class="lg-nucleus"></i>nucleus</span>' +
        '<span><i class="lg-support"></i>stress</span>' +
        '<span><i class="lg-weak"></i>weak</span>' +
        '<span class="lg-arrow rise">↗ rise</span>' +
        '<span class="lg-arrow fall">↘ fall</span>' +
        '<span class="lg-arrow level">→ level</span>' +
        '<span>‖ pause</span>' +
        '</div>';
    }

    function prosodyLineBlockHtml(training, line) {
      const wl = (training && training.word_level_prosody) || null;
      const rawGroups = wl && Array.isArray(wl.groups) ? wl.groups : [];
      const groups = expandDegenerateProsodyGroups(rawGroups);
      const words = wl && Array.isArray(wl.words) ? wl.words : [];
      let body = "";
      if (groups.length) {
        body = prosodyGroupLineHtml(groups, words) + prosodyContourRailHtml(groups) + prosodyLegendHtml();
      } else {
        const fallback = prosodyGuideFallbackHtml(training, line);
        if (fallback) {
          body = fallback + (training.stress_guide || training.intonation_guide ? prosodyLegendHtml() : "");
        } else if (line) {
          body = '<p class="prosody-line">' + esc(line) + '</p>';
        }
      }
      if (!body) return "";
      return '<div class="prosody-card"><span class="label">Today\'s line · stress · pitch · pauses</span>' + body + '</div>';
    }

    function prebuiltDemoAudio(assets) {
      const uri = assets && assets.demo_audio_uri;
      if (!uri) return "";
      return '<audio id="prebuiltDemoAudio" controls preload="metadata" src="' + esc(uri) + '"></audio>';
    }

    function renderReadingCard(training, assets) {
      const panel = $("readingCard");
      if (!panel) return;
      const mediaHtml = readingCardMediaHtml(assets || {});
      const guidesHtml = prosodyGuidesHtml(training || {});
      const groupsHtml = prosodyGroupsHtml((training && training.word_level_prosody) || null);
      const wordsHtml = prosodyWordsHtml((training && training.word_level_prosody) || null);
      if (!mediaHtml && !guidesHtml && !groupsHtml && !wordsHtml) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      panel.innerHTML = [
        '<h3>Reading Card</h3>',
        mediaHtml,
        guidesHtml,
        groupsHtml,
        wordsHtml,
      ].filter(Boolean).join("");
    }

    function readingCardMediaHtml(assets) {
      const daily = readingImageDetails("Daily card", assets.daily_card_uri, true);
      const detail = readingImageDetails("Prosody detail", assets.prosody_detail_uri, false);
      if (!daily && !detail) return "";
      return '<div class="reading-media">' + daily + detail + '</div>';
    }

    function readingImageDetails(label, uri, open) {
      if (!uri) return "";
      return '<details ' + (open ? "open" : "") + '><summary>' + esc(label) + '</summary>' +
        '<img class="reading-card-img" loading="lazy" src="' + esc(uri) + '" alt="' + esc(label) + '">' +
        '</details>';
    }

    function prosodyGuidesHtml(training) {
      const stress = prosodyGuideBlock("Stress guide", training.stress_guide);
      const intonation = prosodyGuideBlock("Intonation guide", training.intonation_guide);
      if (!stress && !intonation) return "";
      return '<div class="prosody-guide-grid">' + stress + intonation + '</div>';
    }

    function prosodyGuideBlock(label, value) {
      const text = String(value || "").trim();
      if (!text) return "";
      return '<div class="prosody-guide"><span class="label">' + esc(label) + '</span><p>' + esc(text) + '</p></div>';
    }

    function prosodyGroupsHtml(wordLevel) {
      const groups = wordLevel && Array.isArray(wordLevel.groups) ? wordLevel.groups : [];
      if (!groups.length) return "";
      const items = groups.map((group, index) => {
        const id = group && group.id != null ? group.id : index + 1;
        const meta = [
          group && group.function ? "Function: " + group.function : "",
          group && group.nucleus ? "Nucleus: " + group.nucleus : "",
          group && group.contour ? "Contour: " + group.contour : "",
          group && group.pause_after ? "Pause: " + group.pause_after : "",
        ].filter(Boolean).join(" | ");
        return '<div class="prosody-group">' +
          '<span class="prosody-row-label">Group ' + esc(id) + '</span>' +
          '<span class="prosody-group-text">' + esc((group && group.text) || "") + '</span>' +
          (meta ? '<span class="prosody-group-meta">' + esc(meta) + '</span>' : '') +
          '</div>';
      }).join("");
      return '<div class="field"><span class="label">Thought groups</span><div class="prosody-groups">' + items + '</div></div>';
    }

    function prosodyWordsHtml(wordLevel) {
      const words = wordLevel && Array.isArray(wordLevel.words) ? wordLevel.words : [];
      if (!words.length) return "";
      const groups = wordLevel && Array.isArray(wordLevel.groups) ? wordLevel.groups : [];
      const byGroup = new Map();
      const order = [];
      for (const group of groups) {
        const key = String(group && group.id != null ? group.id : "");
        if (key && !byGroup.has(key)) {
          byGroup.set(key, []);
          order.push(key);
        }
      }
      for (const word of words) {
        const key = String(word && word.group != null ? word.group : "all");
        if (!byGroup.has(key)) {
          byGroup.set(key, []);
          order.push(key);
        }
        byGroup.get(key).push(word);
      }
      const rows = order.map((key) => {
        const group = groups.find((item) => String(item && item.id) === key) || {};
        const label = key === "all" ? "Words" : "Group " + key;
        const meta = group && group.contour ? " | Contour: " + group.contour : "";
        const chips = (byGroup.get(key) || []).map(prosodyWordChip).join("");
        return '<div class="prosody-word-row">' +
          '<span class="prosody-row-label">' + esc(label + meta) + '</span>' +
          chips +
          '</div>';
      }).join("");
      return '<div class="field"><span class="label">Word-level prosody</span><div class="prosody-word-rows">' + rows + '</div></div>';
    }

    function prosodyWordChip(word) {
      const stress = String((word && word.stress) || "").toLowerCase();
      const cls = prosodyStressClass(stress);
      const mark = prosodyWordMark(word, cls);
      const title = [
        word && word.stress ? "Stress: " + word.stress : "",
        word && word.pitch_role ? "Pitch: " + word.pitch_role : "",
        word && word.arrow ? "Arrow: " + word.arrow : "",
      ].filter(Boolean).join(" | ");
      return '<span class="prosody-word ' + cls + '" title="' + esc(title) + '">' +
        '<span>' + esc((word && word.text) || "") + '</span>' +
        '<span class="prosody-mark">' + esc(mark) + '</span>' +
        '</span>';
    }

    function prosodyStressClass(stress) {
      if (stress.includes("nucleus")) return "nucleus";
      if (stress.includes("support")) return "support";
      if (stress.includes("weak") || stress.includes("unstress")) return "weak";
      return "neutral";
    }

    function prosodyWordMark(word, cls) {
      const arrow = String((word && word.arrow) || "").trim();
      if (cls === "nucleus") return arrow ? "N " + arrow : "N";
      if (cls === "support") return arrow ? "S " + arrow : "S";
      if (cls === "weak") return arrow ? "W " + arrow : "W";
      return arrow || String((word && word.stress) || "").trim();
    }

    function frames(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No frames.</p>';
      return '<ol>' + value.map((item) => '<li>' + esc((item && item.text) || item) + '</li>').join("") + '</ol>';
    }

    function simpleList(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No items.</p>';
      return '<ul>' + value.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>';
    }

    function drillRounds(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No drill rounds.</p>';
      return value.map((round) => {
        const examples = Array.isArray(round.examples) ? round.examples : [];
        const roundLabel = round.label || round.id || "Round";
        return `
          <div class="field">
            <strong>${esc(roundLabel)}</strong>
            ${round.base_frame ? '<p class="text">' + esc(round.base_frame) + '</p>' : ''}
            ${examples.length ? '<ol class="drill-example-list">' + examples.map((item) => {
              const text = typeof item === "string" ? item : (item.text || "");
              const label = (typeof item === "object" && item ? (item.cue || item.label) : "") || roundLabel;
              return drillExampleHtml({ label, text, source: "prebuilt" }, {});
            }).join("") + '</ol>' : ''}
          </div>
        `;
      }).join("");
    }

    function shadowing(value) {
      const chunks = value && Array.isArray(value.chunks) ? value.chunks : [];
      if (!chunks.length) return '<p class="muted">No shadowing chunks.</p>';
      return '<p class="muted">' + esc(value.instruction_zh || "Shadow each chunk twice.") + '</p><ol>' + chunks.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ol>';
    }

    function recentSessions(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No VS Code sessions yet.</p>';
      return value.map((item) => `
        <div class="field">
          <strong>${esc(item.package_date || item.packageDate || "session")}</strong>
          <span class="muted"> · ${esc(item.created_at || item.createdAt || "")}</span>
          ${Array.isArray(item.error_tags) && item.error_tags.length ? '<div class="chips">' + item.error_tags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>' : ''}
          <p class="text">${esc(item.native_version || item.nativeVersion || item.progress_note || "")}</p>
        </div>
      `).join("");
    }

    function shortSourceLabel(value) {
      const text = String(value || "");
      return text.length > 46 ? text.slice(0, 21) + "..." + text.slice(-20) : text;
    }

    function setStatus(text, tone) {
      const el = $("status");
      el.textContent = text;
      el.classList.remove("busy", "error");
      if (tone === "busy") el.classList.add("busy");
      if (tone === "error") el.classList.add("error");
      // Errors must interrupt the screen reader; routine status stays polite.
      el.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    }

    // Recovery net: a hung coach/provider must never trap the user with a
    // permanently disabled record button. Re-enable + advise after a while,
    // without faking success or hiding a late real result/error.
    let processingWatchdog = null;
    function clearProcessingWatchdog() {
      if (processingWatchdog) {
        clearTimeout(processingWatchdog);
        processingWatchdog = null;
      }
    }
    function armProcessingWatchdog() {
      clearProcessingWatchdog();
      processingWatchdog = setTimeout(() => {
        processingWatchdog = null;
        setBusy(false);
        setStatus("Still working — this is taking longer than usual. Keep waiting, or press ↻ to reset.", "busy");
      }, 45000);
    }

    function setRecording(active) {
      const btn = $("record");
      btn.classList.toggle("recording", active);
      btn.setAttribute("aria-label", active ? "Stop recording" : "Start recording");
      btn.setAttribute("title", active ? "Stop recording" : "Start recording");
    }

    function setBusy(active, label) {
      const btn = $("record");
      btn.classList.toggle("busy", active);
      // Don't let an unrelated path (e.g. a failed example-audio request)
      // re-enable the record button while setup is still incomplete — that
      // briefly reopens the wasted-recording trap until the next re-render.
      btn.disabled = active || recordingBlockedBySetup;
      if (label) setStatus(label, active ? "busy" : undefined);
    }

    function currentSettings() {
      return (state && state.settings) || {};
    }

    function recorderBackend() {
      const settings = currentSettings();
      return String(settings.recorderBackend || "macLocal");
    }

    function blockedMicrophonePattern() {
      const settings = currentSettings();
      const pattern = String(settings.blockedMicrophoneNamePattern || "iphone|ipad|continuity|karios");
      try {
        return new RegExp(pattern, "i");
      } catch {
        return /iphone|ipad|continuity|karios/i;
      }
    }

    function isBlockedMicrophone(label) {
      return blockedMicrophonePattern().test(String(label || ""));
    }

    function isLocalMicrophone(label) {
      const text = String(label || "").toLowerCase();
      return ["imac", "macbook", "mac mini", "mac studio", "studio display", "built-in", "built in", "internal"].some((name) => text.includes(name));
    }

    async function localAudioConstraints() {
      const base = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return base;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput" && device.label);
      const settings = currentSettings();
      const preferred = String(settings.preferredMicrophoneName || "").toLowerCase().trim();
      const byPreferredName = preferred
        ? inputs.find((device) => !isBlockedMicrophone(device.label) && device.label.toLowerCase().includes(preferred))
        : undefined;
      const byLocalName = inputs.find((device) => !isBlockedMicrophone(device.label) && isLocalMicrophone(device.label));
      const byAllowedName = inputs.find((device) => !isBlockedMicrophone(device.label));
      const chosen = byPreferredName || byLocalName || byAllowedName;
      if (chosen) {
        return { ...base, deviceId: { exact: chosen.deviceId } };
      }
      return base;
    }

    async function startRecording() {
      clearProcessingWatchdog();
      activeRecordingTarget = consumePracticeTarget();
      if (recorderBackend() === "macLocal") {
        startNativeRecording("Using Mac local microphone.");
        return;
      }
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        startNativeRecording("Webview recorder unavailable.");
        return;
      }
      chunks = [];
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: await localAudioConstraints() });
        const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
        mediaRecorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        mediaRecorder.onstop = async () => {
          try {
            const stoppedRecorder = mediaRecorder;
            const mimeType = (stoppedRecorder && stoppedRecorder.mimeType) || "audio/webm";
            const blob = new Blob(chunks, { type: mimeType });
            if (blob.size < 1000) {
              throw new Error("Recording was empty. Please try again after the microphone indicator appears.");
            }
            setLocalAudioSource(URL.createObjectURL(blob), true);
            setRecording(false);
            setBusy(true, "Sending to coach…");
            showStages(true);
            const base64 = await blobToBase64(blob);
            if (!base64) {
              throw new Error("Recording could not be encoded for processing.");
            }
            const priorTurn = pendingReplyContext;
            const practiceTarget = activeRecordingTarget;
            vscode.postMessage({ type: "practiceAudio", mimeType, base64, priorTurn, practiceTarget });
            armProcessingWatchdog();
          } catch (error) {
            setBusy(false);
            setRecording(false);
            showStages(false);
            setStatus((error && error.message) || String(error), "error");
          } finally {
            stopVuMeter();
            stopTimer();
            if (stream) stream.getTracks().forEach((track) => track.stop());
            stream = null;
            mediaRecorder = null;
            chunks = [];
            recorderMode = null;
            activeRecordingTarget = null;
          }
        };
        recorderMode = "webview";
        mediaRecorder.start();
        setRecording(true);
        setStatus("Listening… speak now.");
        startVuMeter(stream);
        startTimer();
      } catch (error) {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        stream = null;
        mediaRecorder = null;
        chunks = [];
        startNativeRecording((error && error.message) || String(error));
      }
    }

    function stopRecording() {
      if (recorderMode === "native") {
        if (nativeStarting) {
          // The recorder is still spinning up. Don't tear it down half-born;
          // tell the user it's coming. They can stop once it's listening.
          setStatus("Starting recorder — one moment, then it will listen.");
          return;
        }
        vscode.postMessage({ type: "stopNativeRecording" });
        setRecording(false);
        stopTimer();
        setBusy(true, "Stopping native recorder…");
        armProcessingWatchdog();
        recorderMode = null;
        return;
      }
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }

    let recordTransition = false;
    function toggleRecording() {
      if (recordTransition) return;
      if (isRecording()) {
        stopRecording();
        return;
      }
      // Block a second tap during the async getUserMedia/permission window so
      // we never open two microphone streams or fire two pipelines at once.
      recordTransition = true;
      startRecording()
        .catch((error) => setStatus(error.message || String(error), "error"))
        .finally(() => { recordTransition = false; });
    }

    function startNativeRecording(reason) {
      clearProcessingWatchdog();
      recorderMode = "native";
      nativeStarting = true;
      setRecording(true);
      setStatus((reason ? reason + " " : "") + "Using Mac local recorder…");
      startTimer();
      const practiceTarget = activeRecordingTarget || consumePracticeTarget();
      activeRecordingTarget = practiceTarget;
      vscode.postMessage({ type: "startNativeRecording", practiceTarget });
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    function normalizeWord(word) {
      return String(word || "").toLowerCase().replace(/[^a-z0-9']/gi, "");
    }

    function normalizeComparable(text) {
      return String(text || "").toLowerCase().replace(/[^a-z0-9']+/gi, " ").trim();
    }

    function wordDiff(left, right) {
      const a = (String(left || "").match(/\S+/g)) || [];
      const b = (String(right || "").match(/\S+/g)) || [];
      const m = a.length;
      const n = b.length;
      const dp = [];
      for (let i = 0; i <= m; i += 1) {
        dp.push(new Array(n + 1).fill(0));
      }
      for (let i = 0; i < m; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if (normalizeWord(a[i]) && normalizeWord(a[i]) === normalizeWord(b[j])) {
            dp[i + 1][j + 1] = dp[i][j] + 1;
          } else {
            dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }
      const leftMarks = new Array(m).fill("removed");
      const rightMarks = new Array(n).fill("added");
      let i = m;
      let j = n;
      while (i > 0 && j > 0) {
        if (normalizeWord(a[i - 1]) && normalizeWord(a[i - 1]) === normalizeWord(b[j - 1])) {
          leftMarks[i - 1] = "common";
          rightMarks[j - 1] = "common";
          i -= 1;
          j -= 1;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
          i -= 1;
        } else {
          j -= 1;
        }
      }
      return {
        left: a.map((word, k) => ({ word, mark: leftMarks[k] })),
        right: b.map((word, k) => ({ word, mark: rightMarks[k] })),
      };
    }

    function renderDiffSide(items) {
      if (!items.length) return '<span class="muted">—</span>';
      return items.map(({ word, mark }) => {
        const safe = esc(word);
        if (mark === "removed") return '<span class="diff-removed">' + safe + '</span>';
        if (mark === "added") return '<span class="diff-added">' + safe + '</span>';
        return safe;
      }).join(" ");
    }

    function pushDrillExample(list, item, fallbackLabel, source) {
      if (!item) return;
      const text = typeof item === "string" ? item : (item.text || "");
      const cleanText = String(text || "").replace(/\s+/g, " ").trim();
      if (!cleanText) return;
      const label = typeof item === "object"
        ? String(item.label || item.cue || item.id || fallbackLabel || "FSI drill").trim()
        : String(fallbackLabel || "FSI drill");
      const reason = typeof item === "object" ? String(item.reason || item.note || "").trim() : "";
      list.push({ label, text: cleanText, reason, source: source || (item.source || "") });
    }

    function collectDrillExamples(result) {
      const list = [];
      if (Array.isArray(result && result.drillExamples)) {
        result.drillExamples.forEach((item, idx) => pushDrillExample(list, item, item.label || "Coach drill " + (idx + 1), item.source || "coach"));
      }
      const drill = (state && state.drill) || {};
      const rounds = Array.isArray(drill.rounds) ? drill.rounds : [];
      rounds.forEach((round) => {
        const roundLabel = String((round && (round.label || round.id)) || "FSI drill");
        const examples = Array.isArray(round && round.examples) ? round.examples : [];
        examples.forEach((item) => pushDrillExample(list, item, roundLabel, "prebuilt"));
      });
      const chunks = drill && drill.shadowing_loop && Array.isArray(drill.shadowing_loop.chunks)
        ? drill.shadowing_loop.chunks
        : [];
      chunks.forEach((item, idx) => pushDrillExample(list, item, "Shadowing chunk " + (idx + 1), "prebuilt"));

      const blocked = new Set([
        normalizeComparable(result && result.nativeVersion),
        normalizeComparable(result && result.referenceText),
        normalizeComparable(result && result.transcript),
      ].filter(Boolean));
      const seen = new Set();
      return list.filter((item) => {
        const key = normalizeComparable(item.text);
        if (!key || seen.has(key) || blocked.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function collectDrillLibrary() {
      const list = [];
      const drill = (state && state.drill) || {};
      const rounds = Array.isArray(drill.rounds) ? drill.rounds : [];
      rounds.forEach((round) => {
        const roundLabel = String((round && (round.label || round.id)) || "FSI drill");
        const examples = Array.isArray(round && round.examples) ? round.examples : [];
        examples.forEach((item) => pushDrillExample(list, item, roundLabel, "prebuilt"));
      });
      const chunks = drill && drill.shadowing_loop && Array.isArray(drill.shadowing_loop.chunks)
        ? drill.shadowing_loop.chunks
        : [];
      chunks.forEach((item, idx) => pushDrillExample(list, item, "Shadowing chunk " + (idx + 1), "prebuilt"));
      drillGeneratedLines.forEach((item) => pushDrillExample(list, item, item.label || "AI drill", "coach"));

      const seen = new Set();
      return list.filter((item) => {
        const key = normalizeComparable(item.text);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function drillAttemptKey(text) {
      return normalizeComparable(text);
    }

    function drillAttemptCount(text) {
      const key = drillAttemptKey(text);
      return key ? (drillAttempts[key] || 0) : 0;
    }

    function bumpDrillAttempt(text) {
      const key = drillAttemptKey(text);
      if (!key) return 0;
      drillAttempts[key] = (drillAttempts[key] || 0) + 1;
      return drillAttempts[key];
    }

    function updateDrillAttemptBadge(key, count) {
      if (!key) return;
      const safeKey = (window.CSS && CSS.escape) ? CSS.escape(key) : key.replace(/"/g, '\\"');
      const badge = document.querySelector('[data-drill-attempt-badge][data-drill-attempt-key="' + safeKey + '"]');
      if (!badge) return;
      const counter = badge.querySelector('[data-drill-attempt-count]');
      if (counter) counter.textContent = String(count);
      badge.hidden = count <= 0;
    }

    function renderDrillPanel() {
      const host = $("drill");
      if (!host) return;
      const drill = (state && state.drill) || {};
      // Same gate as the record button: generating lines calls the coach, so
      // before a key + lesson exist the button must not invite a click that
      // only fails after a round trip with a raw "Missing API key" error.
      const gate = setupReady(state);
      const generateDisabled = drillGenerating || !gate.ready;
      const generateHint = !gate.ready
        ? (!gate.coreKeysReady
          ? "Add a Gemini API key in Quick setup to generate lines"
          : "Create your first lesson in Quick setup to generate lines")
        : (drillGenerating ? "Generating new lines…" : "Fresh FSI substitutions from your coach model");
      drillLibrary = collectDrillLibrary();
      const tags = Array.isArray(drill.primary_tags) ? drill.primary_tags : [];
      const items = drillLibrary.map((example, index) => drillExampleHtml(example, {
        persistent: true,
        attemptKey: drillAttemptKey(example.text),
        attempts: drillAttemptCount(example.text),
        libIndex: index,
      })).join("");
      const listHtml = drillLibrary.length
        ? '<ol class="drill-example-list">' + items + '</ol>'
        : '<p class="muted">No drill lines yet. Generate a few below.</p>';
      const planHtml = `
        <details class="result-details drill-plan">
          <summary>Drill plan</summary>
          <div class="field"><span class="label">Routine</span>${simpleList(drill.routine_zh)}</div>
          <div class="field"><span class="label">Shadowing</span>${shadowing(drill.shadowing_loop)}</div>
          <div class="field"><span class="label">Repair focus</span>${simpleList(drill.repair_drills)}</div>
        </details>`;
      host.innerHTML = `
        <div class="drill-head">
          <h3>Drill workbench</h3>
          <span class="muted">${drillLibrary.length} line${drillLibrary.length === 1 ? "" : "s"} · practice as many times as you like</span>
        </div>
        <div class="chips">
          <span class="chip">${esc(drill.method || "FSI-style drill")}</span>
          ${tags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("")}
          ${drill.required_frames ? '<span class="chip">use ' + esc(drill.required_frames) + ' frames</span>' : ''}
        </div>
        ${listHtml}
        <div class="loop-actions drill-generate-row">
          <button class="secondary" data-drill-generate="5" ${generateDisabled ? "disabled" : ""}>＋ Generate 5 more lines</button>
          <span class="muted" id="drillGenStatus">${esc(generateHint)}</span>
        </div>
        ${planHtml}
      `;
    }

    function drillChoiceHtml(examples) {
      if (!Array.isArray(examples) || !examples.length) return "";
      const items = examples.map((example, index) => drillExampleHtml(example, { index })).join("");
      return '<div class="fsi-choice-card">' +
        '<div class="fsi-choice-head"><strong>FSI next lines</strong><span>choose practice or skip</span></div>' +
        '<ol class="drill-example-list">' + items + '</ol>' +
        '<div class="loop-actions"><button class="secondary" data-drill-skip="1">Skip drill</button></div>' +
      '</div>';
    }

    function drillExampleHtml(example, options) {
      const opts = options || {};
      const indexAttr = opts.index != null ? ' data-drill-index="' + esc(opts.index) + '"' : '';
      const textAttr = indexAttr ? '' : ' data-drill-text="' + esc(example.text || "") + '" data-drill-label="' + esc(example.label || "FSI drill") + '"';
      const persistent = Boolean(opts.persistent);
      const attempts = Number(opts.attempts) || 0;
      const keyAttr = opts.attemptKey ? ' data-drill-attempt-key="' + esc(opts.attemptKey) + '"' : '';
      const badge = persistent
        ? '<span class="drill-attempt-badge" data-drill-attempt-badge="1"' + keyAttr + (attempts ? '' : ' hidden') + '>⟳ <span data-drill-attempt-count="1">' + esc(attempts) + '</span></span>'
        : '';
      const practiceLabel = persistent ? (attempts ? "Practice again" : "Practice") : "Practice";
      const sourceTag = persistent && example.source === "coach"
        ? '<span class="drill-example-source">AI</span>'
        : '';
      return '<li class="drill-example"' + keyAttr + '>' +
        '<span class="drill-example-label">' + esc(example.label || "FSI drill") + sourceTag + badge + '</span>' +
        '<p class="drill-example-text">' + esc(example.text || "") + '</p>' +
        (example.reason ? '<p class="drill-example-reason">' + esc(example.reason) + '</p>' : '') +
        '<div class="drill-example-actions">' +
          '<button class="secondary" data-drill-listen="1"' + indexAttr + textAttr + '>Listen</button>' +
          '<button data-drill-practice="1"' + indexAttr + textAttr + keyAttr + '>' + practiceLabel + '</button>' +
        '</div>' +
      '</li>';
    }

    function drillExampleFromTrigger(trigger) {
      const idx = Number(trigger.dataset.drillIndex);
      if (Number.isFinite(idx) && idx >= 0 && currentDrillSuggestions[idx]) {
        return currentDrillSuggestions[idx];
      }
      const text = String(trigger.dataset.drillText || "").trim();
      if (!text) return null;
      return {
        label: String(trigger.dataset.drillLabel || "FSI drill").trim(),
        text,
      };
    }

    // Bring the record button into view and tell the user to start when ready.
    // Auto-starting recording from "Practice"/"Imitate"/"Reply" clipped the
    // opening words of every rep (the user is still reading the line). Recording
    // now always begins on an explicit tap of the red button, which consumes
    // the pendingPracticeTarget / reply context set just before this call.
    function cueRecording(label) {
      const cta = $("record");
      if (cta) {
        if (typeof cta.scrollIntoView === "function") {
          cta.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        if (typeof cta.focus === "function") {
          cta.focus({ preventScroll: true });
        }
      }
      setStatus(label
        ? "Ready — press the red button when you want to record: " + label
        : "Ready — press the red button to record.");
    }

    function startDrillPractice(example) {
      if (!example || !String(example.text || "").trim()) return;
      pendingReplyContext = null;
      pendingPracticeTarget = practiceTarget(example.text, example.label || "FSI drill", "");
      vscode.postMessage({ type: "clearReplyContext" });
      cueRecording(example.label || "this line");
    }

    function followUpCardHtml(result, followUpAudioSrc) {
      if (!result || !result.followUpQuestion) return "";
      const audioTag = followUpAudioSrc
        ? '<audio id="followUpAudio" controls preload="auto" src="' + esc(followUpAudioSrc) + '"></audio>'
        : '';
      return '<div class="follow-up-card">' +
        '<span class="follow-up-label">Coach asks</span>' +
        '<p class="follow-up-text">' + esc(result.followUpQuestion) + '</p>' +
        audioTag +
        '<div class="loop-actions">' +
          '<button type="button" class="slow-read-btn" data-slow-read="followUp" title="Re-read at 0.7×">🐢 Slow read</button>' +
          '<button type="button" id="answerFollowUpBtn" data-loop-action="reply">Answer follow-up →</button>' +
        '</div>' +
      '</div>';
    }

    let lastTurn = null;
    let pendingReplyContext = null;
    let turnHistory = [];

    function turnBreadcrumbHtml() {
      const total = turnHistory.length;
      if (total === 0) return "";
      const items = turnHistory.map((turn, idx) => {
        const isCurrent = idx === total - 1;
        const cls = "turn-chip " + (isCurrent ? "current" : "done");
        const replyTag = turn.priorTurn ? '<span class="turn-chip-tag">reply</span>' : "";
        const check = isCurrent ? "" : " ✓";
        return '<span class="' + cls + '" data-turn-index="' + (idx + 1) + '" role="button" tabindex="0">Turn ' + (idx + 1) + check + replyTag + '</span>';
      });
      return '<div class="turn-breadcrumb" aria-label="Conversation turns">' + items.join('<span class="turn-arrow" aria-hidden="true">→</span>') + '</div>';
    }

    function renderTurnHistory() {
      const panel = $("turnHistory");
      if (!panel) return;
      if (turnHistory.length <= 1) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      const earlier = turnHistory.slice(0, -1);
	      const items = earlier.map((turn) => {
	        const audio = turn.userAudioUri ? '<audio controls src="' + esc(turn.userAudioUri) + '"></audio>' : '';
	        const nativeAudio = turn.nativeAudioUri ? '<audio controls src="' + esc(turn.nativeAudioUri) + '"></audio>' : '';
	        const nativeLabel = turn.mode === "shadow" ? (turn.referenceLabel || "Reference") : "Native";
	        const followUpBlock = turn.followUpQuestion
          ? '<div class="turn-followup"><span class="muted">→ Coach asked:</span> ' + esc(turn.followUpQuestion) + '</div>'
          : '';
        const replyTag = turn.priorTurn ? '<span class="turn-chip-tag">reply</span>' : '';
        return '<li class="turn-item" data-turn-item="' + esc(String(turn.turnIndex)) + '">' +
          '<div class="turn-head"><span class="turn-num">Turn ' + esc(String(turn.turnIndex)) + '</span>' + replyTag + '</div>' +
          '<div class="turn-cols">' +
            '<div class="turn-col"><span class="muted">You said</span><p>' + esc(turn.transcript) + '</p>' + audio + '</div>' +
	            '<div class="turn-col"><span class="muted">' + esc(nativeLabel) + '</span><p>' + esc(turn.nativeVersion) + '</p>' + nativeAudio + '</div>' +
          '</div>' +
          followUpBlock +
        '</li>';
      }).join("");
      panel.innerHTML =
        '<div class="turn-history-head">' +
          '<h3>Conversation so far</h3>' +
          '<button class="ghost" id="resetTurns" title="Start a new conversation">Reset</button>' +
        '</div>' +
        '<ol class="turn-history">' + items + '</ol>';
      const reset = $("resetTurns");
      if (reset) {
        let resetArmed = false;
        let resetArmTimer = null;
        reset.addEventListener("click", () => {
          // A multi-turn conversation is real practice work; one stray click on
          // a ghost button must not wipe it silently. Require a confirm click,
          // auto-disarming after a few seconds.
          if (!resetArmed) {
            resetArmed = true;
            reset.textContent = "Reset? click again";
            reset.setAttribute("title", "Click again to clear this conversation");
            resetArmTimer = setTimeout(() => {
              resetArmed = false;
              reset.textContent = "Reset";
              reset.setAttribute("title", "Start a new conversation");
            }, 4000);
            return;
          }
          if (resetArmTimer) clearTimeout(resetArmTimer);
          turnHistory = [];
          lastTurn = null;
          pendingReplyContext = null;
          vscode.postMessage({ type: "clearReplyContext" });
          renderTurnHistory();
          $("result").hidden = true;
          setStatus("New conversation. Tap to speak.");
        });
      }
    }

	    function renderResult(result) {
	      const diff = wordDiff(result.transcript, result.nativeVersion);
	      const userAudioSrc = (result && result.localAudioUri) || ($("localAudio").src || "");
	      const nativeAudioSrc = (result && result.audioUri) || "";
	      const followUpAudioSrc = (result && result.followUpAudioUri) || "";
	      const isShadow = result && result.mode === "shadow";
	      const nativeLabel = isShadow ? (result.referenceLabel || "Reference") : "Native says";
	      const heading = isShadow ? "Shadowing check" : "Coaching";
      currentDrillSuggestions = collectDrillExamples(result || {});
      const tagsHtml = Array.isArray(result.errorTags) && result.errorTags.length
        ? '<div class="chips">' + result.errorTags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>'
        : '<p class="muted">No tags.</p>';
      const problemsHtml = Array.isArray(result.problems) && result.problems.length
        ? '<ul>' + result.problems.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>'
        : '<p class="muted">No specific problems.</p>';

      $("result").hidden = false;
      $("result").innerHTML = `
	        <h3>${heading} · Turn ${turnHistory.length || 1}</h3>
        ${turnBreadcrumbHtml()}
        <div class="diff-card">
          <div class="diff-side diff-you">
            <div class="diff-label">You said</div>
            <p class="diff-text">${renderDiffSide(diff.left)}</p>
          </div>
          <div class="diff-side diff-native">
	            <div class="diff-label">${esc(nativeLabel)}</div>
            <p class="diff-text">${renderDiffSide(diff.right)}</p>
          </div>
        </div>
        <div class="ab-audio">
          <div class="ab-side">
            <span class="ab-label muted">Your audio</span>
            ${userAudioSrc ? '<audio controls src="' + esc(userAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
          <div class="ab-side">
            <span class="ab-label muted">Native audio
              ${result.nativeVersion ? '<button type="button" class="slow-read-btn" data-slow-read="native" title="Re-read at 0.7×">🐢 Slow</button>' : ''}
            </span>
            ${nativeAudioSrc ? '<audio id="nativeAudio" controls src="' + esc(nativeAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
        </div>
        ${result.quickFix ? '<div class="quick-fix-card"><span class="label">Quick fix</span><p>' + esc(result.quickFix) + '</p></div>' : ''}
        ${followUpCardHtml(result, followUpAudioSrc)}
        <div class="loop-actions">
          <button class="secondary" data-loop-action="imitate">${isShadow ? "Practice " + esc(nativeLabel) + " again" : "Imitate native"}</button>
        </div>
        ${drillChoiceHtml(currentDrillSuggestions)}
        <details class="result-details">
          <summary>More details</summary>
          <div class="field"><span class="label">Problems</span>${problemsHtml}</div>
          <div class="field"><span class="label">Tags</span>${tagsHtml}</div>
          ${result.shadowingInstruction ? '<div class="field"><span class="label">Repeat</span><p class="text">' + esc(result.shadowingInstruction) + '</p></div>' : ''}
          ${result.nextDrill ? '<div class="field"><span class="label">Next drill</span><p class="text">' + esc(result.nextDrill) + '</p></div>' : ''}
          <div class="field"><span class="label">Session folder</span><code>${esc(result.sessionDir)}</code></div>
        </details>
      `;
      const followUpAudioEl = $("followUpAudio");
      const answerBtn = $("answerFollowUpBtn");
      if (followUpAudioEl && answerBtn) {
        followUpAudioEl.addEventListener("ended", () => {
          if (typeof answerBtn.focus === "function") {
            answerBtn.focus({ preventScroll: false });
          }
        }, { once: true });
      }
    }

    $("record").addEventListener("click", toggleRecording);
    $("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    function focusTurnChip(trigger) {
      const idx = Number(trigger.dataset.turnIndex);
      if (!Number.isFinite(idx) || idx <= 0) return false;
      const targetItem = document.querySelector('[data-turn-item="' + idx + '"]');
      if (targetItem && typeof targetItem.scrollIntoView === "function") {
        targetItem.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      }
      if (idx === turnHistory.length) {
        const result = $("result");
        if (result && typeof result.scrollIntoView === "function") {
          result.scrollIntoView({ behavior: "smooth", block: "start" });
          return true;
        }
      }
      return false;
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const trigger = event.target.closest && event.target.closest("[data-turn-index]");
      if (!trigger) return;
      event.preventDefault();
      focusTurnChip(trigger);
    });
    document.addEventListener("click", (event) => {
      const breadcrumbTrigger = event.target.closest && event.target.closest("[data-turn-index]");
      if (breadcrumbTrigger) {
        if (focusTurnChip(breadcrumbTrigger)) return;
      }
      const drillListenTrigger = event.target.closest && event.target.closest("[data-drill-listen]");
      if (drillListenTrigger) {
        const example = drillExampleFromTrigger(drillListenTrigger);
        if (!example || !String(example.text || "").trim()) return;
        pendingSlowReadHost = drillListenTrigger.closest(".drill-example");
        drillListenTrigger.disabled = true;
        drillListenTrigger.dataset.busy = "1";
        drillListenTrigger.textContent = "Listening…";
        vscode.postMessage({ type: "slowRead", text: example.text, target: "drill", speed: 0.85 });
        const listenBtn = drillListenTrigger;
        setTimeout(() => {
          if (listenBtn && listenBtn.dataset.busy === "1") {
            listenBtn.disabled = false;
            delete listenBtn.dataset.busy;
            listenBtn.textContent = "Listen";
          }
        }, 20000);
        return;
      }
      const heroPracticeTrigger = event.target.closest && event.target.closest("[data-hero-practice]");
      if (heroPracticeTrigger) {
        const text = String(currentExampleText || "").trim();
        if (!text) {
          setStatus("No example line to practice yet.", "error");
          return;
        }
        startDrillPractice({ text, label: "Today's line" });
        return;
      }
      const drillPracticeTrigger = event.target.closest && event.target.closest("[data-drill-practice]");
      if (drillPracticeTrigger) {
        const example = drillExampleFromTrigger(drillPracticeTrigger);
        if (drillPracticeTrigger.dataset.drillAttemptKey && example && example.text) {
          const count = bumpDrillAttempt(example.text);
          updateDrillAttemptBadge(drillPracticeTrigger.dataset.drillAttemptKey, count);
          drillPracticeTrigger.textContent = "Practice again";
        }
        startDrillPractice(example);
        return;
      }
      const drillGenerateTrigger = event.target.closest && event.target.closest("[data-drill-generate]");
      if (drillGenerateTrigger) {
        if (drillGenerating) return;
        // Defense in depth: the button is rendered disabled before setup, but
        // never let a stray click run the coach into a guaranteed key error.
        if (!setupReady(state).ready) return;
        const count = Number(drillGenerateTrigger.dataset.drillGenerate) || 5;
        drillGenerating = true;
        drillGenerateTrigger.disabled = true;
        const status = $("drillGenStatus");
        if (status) status.textContent = "Generating new lines…";
        const existing = drillLibrary.map((item) => item.text);
        vscode.postMessage({ type: "generateDrillLines", count, existing });
        return;
      }
      const drillSkipTrigger = event.target.closest && event.target.closest("[data-drill-skip]");
      if (drillSkipTrigger) {
        const card = drillSkipTrigger.closest(".fsi-choice-card");
        if (card) card.hidden = true;
        currentDrillSuggestions = [];
        setStatus("FSI drill skipped. Ready for free practice.");
        return;
      }
      const slowTrigger = event.target.closest && event.target.closest("[data-slow-read]");
      if (slowTrigger) {
        const target = slowTrigger.dataset.slowRead;
        const text = target === "followUp"
          ? (lastTurn && lastTurn.followUpQuestion) || ""
          : (lastTurn && lastTurn.nativeVersion) || "";
        if (!text.trim()) return;
        slowTrigger.disabled = true;
        slowTrigger.dataset.busy = "1";
        slowTrigger.textContent = "🐢 …";
        vscode.postMessage({ type: "slowRead", text, target, speed: 0.7 });
        const slowBtn = slowTrigger;
        setTimeout(() => {
          if (slowBtn && slowBtn.dataset.busy === "1") {
            slowBtn.disabled = false;
            delete slowBtn.dataset.busy;
            slowBtn.textContent = slowBtn.dataset.slowRead === "followUp" ? "🐢 Slow read" : "🐢 Slow";
          }
        }, 20000);
        return;
      }
      const trigger = event.target.closest && event.target.closest("[data-loop-action]");
      if (!trigger) return;
      const action = trigger.dataset.loopAction;
      if (action !== "imitate" && action !== "reply") return;
      const imitateLabel = lastTurn && lastTurn.mode === "shadow"
        ? (lastTurn.referenceLabel || "the reference line")
        : "the native version";
      if (action === "reply" && lastTurn && lastTurn.followUpQuestion) {
        pendingReplyContext = {
          nativeVersion: lastTurn.nativeVersion || "",
          followUpQuestion: lastTurn.followUpQuestion || "",
          userTranscript: lastTurn.transcript || "",
        };
        pendingPracticeTarget = null;
        vscode.postMessage({ type: "setReplyContext", priorTurn: pendingReplyContext });
      } else if (action === "imitate" && lastTurn && lastTurn.nativeVersion) {
        pendingReplyContext = null;
        pendingPracticeTarget = practiceTarget(
          lastTurn.nativeVersion,
          lastTurn.mode === "shadow" ? (lastTurn.referenceLabel || "Reference") : "Native version",
          lastTurn.followUpQuestion || "",
        );
        vscode.postMessage({ type: "clearReplyContext" });
      } else {
        pendingReplyContext = null;
        pendingPracticeTarget = null;
        vscode.postMessage({ type: "clearReplyContext" });
      }
      cueRecording(action === "imitate" ? imitateLabel : "your reply to the follow-up");
    });
    document.addEventListener("click", (event) => {
      const actionTrigger = event.target.closest && event.target.closest("[data-action]");
      if (actionTrigger && actionTrigger.dataset.action === "today-tts") {
        const status = $("todayTtsStatus");
        if (status) status.textContent = "Generating example…";
        actionTrigger.disabled = true;
        actionTrigger.dataset.busy = "1";
        vscode.postMessage({ type: "todayTts" });
        // Self-heal: if a TTS provider hangs without ever returning a result
        // or error, don't leave this button dead with no way back.
        const ttsBtn = actionTrigger;
        setTimeout(() => {
          if (ttsBtn && ttsBtn.dataset.busy === "1") {
            ttsBtn.disabled = false;
            delete ttsBtn.dataset.busy;
            const s = $("todayTtsStatus");
            if (s) s.textContent = "Example audio took too long — press 🔊 to try again.";
          }
        }, 25000);
        return;
      }
      const geminiTrigger = event.target.closest && event.target.closest("#useGeminiOnly");
      if (geminiTrigger) {
        vscode.postMessage({ type: "useGeminiOnly" });
        return;
      }
      const keyTrigger = event.target.closest && event.target.closest("[data-key]");
      if (keyTrigger) {
        vscode.postMessage({ type: "configureKey", provider: keyTrigger.dataset.key });
        return;
      }
      const providerTrigger = event.target.closest && event.target.closest("[data-provider-setting]");
      if (providerTrigger) {
        vscode.postMessage({
          type: "setProvider",
          setting: providerTrigger.dataset.providerSetting,
          value: providerTrigger.dataset.providerValue,
        });
        return;
      }
      const configTrigger = event.target.closest && event.target.closest("[data-config-setting]");
      if (configTrigger) {
        vscode.postMessage({ type: "configureSetting", setting: configTrigger.dataset.configSetting });
        return;
      }
      const trigger = event.target.closest && event.target.closest("[data-onboard]");
      if (!trigger) return;
      const action = trigger.dataset.onboard;
      if (action === "source") {
        vscode.postMessage({ type: "command", command: "configureMaterials" });
      } else if (action === "provider-key") {
        vscode.postMessage({ type: "command", command: "setupProviderKey" });
      } else if (action === "create-sample") {
        vscode.postMessage({ type: "command", command: "createSamplePackage" });
      } else if (action === "generate-next") {
        vscode.postMessage({ type: "command", command: "generateNextPackage" });
      } else if (action === "compose-material") {
        vscode.postMessage({ type: "command", command: "composeMaterialPrompt" });
      } else if (action === "materials-guide") {
        vscode.postMessage({ type: "command", command: "openMaterialsGuide" });
      }
    });
    $("completeLocal").addEventListener("click", () => vscode.postMessage({ type: "completeLocal" }));
    $("configureMaterials").addEventListener("click", () => vscode.postMessage({ type: "command", command: "configureMaterials" }));
    $("openTask").addEventListener("click", () => vscode.postMessage({ type: "command", command: "openTask" }));
    $("openFolder").addEventListener("click", () => vscode.postMessage({ type: "command", command: "openSessionFolder" }));

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "state") renderState(message.state);
      if (message.type === "busy") setStatus(message.message || "Working…", "busy");
      if (message.type === "nativeRecordingStarted") {
        nativeStarting = false;
        setStatus("Listening… speak now.");
      }
      if (message.type === "stage") {
        if (message.show) showStages(true);
        if (message.stage) setStage(message.stage, message.status || "active");
      }
      if (message.type === "practiceResult") {
        clearProcessingWatchdog();
        nativeStarting = false;
        markAllStagesDone();
        setBusy(false);
	        setStatus("Ready ✓");
	        recorderMode = null;
	        pendingReplyContext = null;
	        pendingPracticeTarget = null;
	        activeRecordingTarget = null;
        if (message.result && message.result.localAudioUri) {
          setLocalAudioSource(message.result.localAudioUri, false);
        }
        const r = message.result || {};
        lastTurn = {
          nativeVersion: r.nativeVersion || "",
          followUpQuestion: r.followUpQuestion || "",
          transcript: r.transcript || "",
          mode: r.mode || "free",
          referenceLabel: r.referenceLabel || "",
        };
        const localAudioFallback = r.localAudioUri || ($("localAudio").src || "");
        turnHistory.push({
          turnIndex: turnHistory.length + 1,
          transcript: r.transcript || "",
          nativeVersion: r.nativeVersion || "",
          mode: r.mode || "free",
          referenceLabel: r.referenceLabel || "",
          followUpQuestion: r.followUpQuestion || "",
          quickFix: r.quickFix || "",
          userAudioUri: localAudioFallback,
          nativeAudioUri: r.audioUri || "",
          followUpAudioUri: r.followUpAudioUri || "",
          priorTurn: r.priorTurn || null,
          timestamp: Date.now(),
        });
        renderResult(message.result);
        renderTurnHistory();
        const resultPanel = $("result");
        if (resultPanel && typeof resultPanel.scrollIntoView === "function") {
          resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        // Land keyboard/screen-reader users on the fresh coaching result
        // instead of leaving focus on the (re-rendered) record button.
        if (resultPanel && typeof resultPanel.focus === "function") {
          resultPanel.focus({ preventScroll: true });
        }
        setTimeout(() => showStages(false), 1500);
      }
      if (message.type === "todayTtsStatus") {
        const status = $("todayTtsStatus");
        if (status) status.textContent = message.message || "Generating…";
      }
      if (message.type === "slowReadStatus") {
        // No-op for now; could surface inline status later.
      }
      if (message.type === "slowReadResult") {
        document.querySelectorAll('[data-slow-read]').forEach((btn) => {
          if (btn.dataset.busy === "1") {
            btn.disabled = false;
            delete btn.dataset.busy;
            btn.textContent = btn.dataset.slowRead === "followUp" ? "🐢 Slow read" : "🐢 Slow";
          }
        });
        document.querySelectorAll('[data-drill-listen]').forEach((btn) => {
          if (btn.dataset.busy === "1") {
            btn.disabled = false;
            delete btn.dataset.busy;
            btn.textContent = "Listen";
          }
        });
        if (message.error) {
          // Clear the drill host too, or a later non-drill slow read would
          // append its player into this stale, now-irrelevant drill card.
          pendingSlowReadHost = null;
          setStatus("Slow read failed: " + message.error, "error");
          return;
        }
        if (message.result && message.result.audioDataUri) {
          let player = document.getElementById("slowReadAudio");
          if (!player) {
            player = document.createElement("audio");
            player.id = "slowReadAudio";
            player.controls = true;
            player.style.width = "100%";
            player.style.marginTop = "6px";
            document.body.appendChild(player);
          }
          const followUpCard = document.querySelector(".follow-up-card");
          const nativeSide = document.querySelector('.ab-side audio#nativeAudio');
          const host = message.target === "drill" && pendingSlowReadHost
            ? pendingSlowReadHost
            : message.target === "followUp" && followUpCard
            ? followUpCard
            : (nativeSide ? nativeSide.parentNode : null);
          if (host && player.parentNode !== host) {
            host.appendChild(player);
          }
          player.src = message.result.audioDataUri;
          player.hidden = false;
          player.play().catch(() => {});
          if (message.target === "drill") {
            pendingSlowReadHost = null;
          }
        }
      }
      if (message.type === "todayTtsResult") {
        const audio = $("todayAudio");
        const status = $("todayTtsStatus");
        if (audio && message.result && message.result.audioDataUri) {
          audio.src = message.result.audioDataUri;
          audio.hidden = false;
          audio.play().catch(() => {});
        }
        let armedShadow = false;
        if (message.result && message.result.text) {
          pendingPracticeTarget = practiceTarget(message.result.text, "Example text", "");
          armedShadow = true;
        } else if (currentExampleText) {
          pendingPracticeTarget = practiceTarget(currentExampleText, "Example text", "");
          armedShadow = true;
        }
        if (status) {
          status.textContent = message.result && message.result.provider
            ? "Example generated with " + message.result.provider + " · next recording shadows this text"
            : "Example generated";
        }
        // #todayTtsStatus lives inside #task and is wiped by the next
        // renderTodayHero, but the shadow target stays armed — so without a
        // cue on the persistent #status the user silently records in shadow
        // mode after any refresh. setStatus writes to #status, which no
        // re-render regenerates, so this survives until the next action.
        if (armedShadow) {
          setStatus("Example ready — your next recording will shadow it. Press the red button when you're ready.");
        }
        const button = document.querySelector('[data-action="today-tts"]');
        if (button) {
          button.disabled = false;
          delete button.dataset.busy;
        }
      }
      if (message.type === "drillLinesStatus") {
        const status = $("drillGenStatus");
        if (status) status.textContent = message.message || "Generating new lines…";
      }
      if (message.type === "drillLinesResult") {
        drillGenerating = false;
        if (message.error) {
          const status = $("drillGenStatus");
          if (status) status.textContent = "Generation failed: " + message.error;
          const button = document.querySelector("[data-drill-generate]");
          if (button) button.disabled = false;
          setStatus("Drill generation failed: " + message.error, "error");
          return;
        }
        const incoming = Array.isArray(message.lines) ? message.lines : [];
        const known = new Set(drillLibrary.map((item) => normalizeComparable(item.text)));
        let added = 0;
        incoming.forEach((item) => {
          const text = String((item && item.text) || "").replace(/\s+/g, " ").trim();
          const key = normalizeComparable(text);
          if (!text || !key || known.has(key)) return;
          known.add(key);
          added += 1;
          drillGeneratedLines.push({
            label: String((item && item.label) || "AI drill").trim() || "AI drill",
            text,
            reason: String((item && item.reason) || "").trim(),
            source: "coach",
          });
        });
        renderDrillPanel();
        const status = $("drillGenStatus");
        if (status) {
          status.textContent = added
            ? "Added " + added + " new line" + (added === 1 ? "" : "s") + " · practice them above"
            : "No new lines this time — try again";
        }
        setStatus(added ? "Added " + added + " fresh FSI line" + (added === 1 ? "" : "s") : "No new drill lines generated");
      }
      if (message.type === "error") {
        clearProcessingWatchdog();
        nativeStarting = false;
        if (recorderMode === "native") {
          recorderMode = null;
          setRecording(false);
        }
        stopVuMeter();
        stopTimer();
        setBusy(false);
        const todayButton = document.querySelector('[data-action="today-tts"]');
        if (todayButton) {
          todayButton.disabled = false;
          delete todayButton.dataset.busy;
        }
        showStages(false);
        setStatus(message.message || "Error.", "error");
      }
    });

    vscode.postMessage({ type: "ready" });
