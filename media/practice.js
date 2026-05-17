    const vscode = acquireVsCodeApi();
    let mediaRecorder = null;
    let stream = null;
    let chunks = [];
    let recorderMode = null;
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
    let pendingSlowReadHost = null;
    const STAGES = ["transcribe", "coach", "tts", "save"];
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
      renderProgress(state.progress);
      renderSourceDiagnostics(state.sourceDiagnostics);
      renderLearnerProfile(state.learnerProfile);
      const weekTag = state.progress && state.progress.weekIndex
        ? "Week " + state.progress.weekIndex + " · Day " + state.progress.dayInWeek + "/" + (state.progress.weekTotalDays || 7)
        : "";
      $("task").innerHTML = `
        <h2>${esc(next.completion_label || "Current Package")} ${next.package_date ? "· " + esc(next.package_date) : ""}</h2>
        ${weekTag ? '<p class="muted" style="margin: 0 0 8px;">' + esc(weekTag) + '</p>' : ''}
        <div class="chips">
          <span class="chip">${esc(state.source || "local")} source</span>
          <span class="chip">${esc(settings.coachProvider || "gemini")} coach</span>
          <span class="chip">${esc(settings.audioUnderstandingProvider || "gemini")} speech in</span>
          <span class="chip">${esc(settings.ttsProvider || "gemini")} speech out</span>
          <span class="chip">${esc(next.training_type || "practice")}</span>
        </div>
        <p>${esc(training.goal || next.goal || "")}</p>
        <p class="muted">${esc(training.scenario || next.scenario || "")}</p>
        <div class="field"><span class="label">Frames</span>${frames(training.frames)}</div>
        <div class="field"><span class="label">Example text</span><p class="text">${esc(todayAudioText)}</p></div>
        <div class="field">
          <span class="label">Example audio</span>
          ${prebuiltDemoAudio(assets)}
          <div class="row">
            <button class="secondary" data-action="today-tts" ${todayAudioText ? "" : "disabled"}>Generate Example</button>
            <span class="muted" id="todayTtsStatus">Reads example only, with ${esc(settings.ttsProvider || "gemini")}</span>
          </div>
          <audio id="todayAudio" controls hidden></audio>
        </div>
      `;
      renderReadingCard(training, assets);
      $("drill").innerHTML = `
        <h3>Drill</h3>
        <div class="chips">
          <span class="chip">${esc(drill.method || "FSI-style drill")}</span>
          ${(drill.primary_tags || []).map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("")}
          ${drill.required_frames ? '<span class="chip">use ' + esc(drill.required_frames) + ' frames</span>' : ''}
        </div>
        <div class="field"><span class="label">Routine</span>${simpleList(drill.routine_zh)}</div>
        <div class="field"><span class="label">Rounds</span>${drillRounds(drill.rounds)}</div>
        <div class="field"><span class="label">Shadowing</span>${shadowing(drill.shadowing_loop)}</div>
        <div class="field"><span class="label">Repair focus</span>${simpleList(drill.repair_drills)}</div>
      `;
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
          : current.toFixed(2).replace(/0+$/, "").replace(/.$/, "");
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
      kimi: "Kimi",
      deepseek: "DeepSeek"
    };

    const PROVIDER_ROUTES = {
      coachProvider: [
        { value: "gemini", label: "Gemini", note: "default coach", modelSetting: "geminiCoachModel" },
        { value: "minimax", label: "MiniMax", note: "optional fallback", modelSetting: "minimaxCoachModel" },
        { value: "mimo", label: "MiMo", note: "optional fallback", modelSetting: "mimoCoachModel" },
        { value: "openai", label: "OpenAI", note: "optional GPT coach", modelSetting: "openaiCoachModel" },
        { value: "kimi", label: "Kimi", note: "Moonshot", modelSetting: "kimiCoachModel" },
        { value: "deepseek", label: "DeepSeek", note: "reasoning alternate", modelSetting: "deepseekCoachModel" },
      ],
      audioUnderstandingProvider: [
        { value: "gemini", label: "Gemini", note: "default STT match", modelSetting: "geminiAudioUnderstandingModel" },
        { value: "openai", label: "OpenAI Realtime", note: "low-latency STT", modelSetting: "openaiRealtimeTranscriptionModel" },
      ],
      ttsProvider: [
        { value: "gemini", label: "Gemini", note: "default TTS", modelSetting: "geminiTtsModel", extraSetting: "geminiTtsVoice", extraLabel: "Voice" },
        { value: "minimax", label: "MiniMax", note: "optional fallback", modelSetting: "minimaxTtsModel" },
        { value: "openai", label: "OpenAI", note: "OpenAI voices", modelSetting: "openaiTtsModel", extraSetting: "openaiTtsVoice", extraLabel: "Voice" },
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
      return '<div class="key-strip">' + ["gemini", "openai", "minimax", "mimo", "kimi", "deepseek"].map((name) => {
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
          '<button class="secondary" id="useRecommendedHybrid">Gemini core</button>',
          '<button class="secondary" id="useGeminiOnly">Gemini only</button>',
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
      btn.disabled = active;
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
            $("localAudio").src = URL.createObjectURL(blob);
            $("localAudio").hidden = false;
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
        vscode.postMessage({ type: "stopNativeRecording" });
        setRecording(false);
        stopTimer();
        setBusy(true, "Stopping native recorder…");
        recorderMode = null;
        return;
      }
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }

    function toggleRecording() {
      if (isRecording()) {
        stopRecording();
      } else {
        startRecording().catch((error) => setStatus(error.message || String(error), "error"));
      }
    }

    function startNativeRecording(reason) {
      recorderMode = "native";
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
      }).slice(0, 5);
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
      const indexAttr = options && options.index != null ? ' data-drill-index="' + esc(options.index) + '"' : '';
      const textAttr = indexAttr ? '' : ' data-drill-text="' + esc(example.text || "") + '" data-drill-label="' + esc(example.label || "FSI drill") + '"';
      return '<li class="drill-example">' +
        '<span class="drill-example-label">' + esc(example.label || "FSI drill") + '</span>' +
        '<p class="drill-example-text">' + esc(example.text || "") + '</p>' +
        (example.reason ? '<p class="drill-example-reason">' + esc(example.reason) + '</p>' : '') +
        '<div class="drill-example-actions">' +
          '<button class="secondary" data-drill-listen="1"' + indexAttr + textAttr + '>Listen</button>' +
          '<button data-drill-practice="1"' + indexAttr + textAttr + '>Practice</button>' +
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

    function startDrillPractice(example) {
      if (!example || !String(example.text || "").trim()) return;
      pendingReplyContext = null;
      pendingPracticeTarget = practiceTarget(example.text, example.label || "FSI drill", "");
      vscode.postMessage({ type: "clearReplyContext" });
      setStatus("FSI drill ready: " + (example.label || "next line"));
      const cta = $("record");
      if (cta && typeof cta.scrollIntoView === "function") {
        cta.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (!isRecording()) {
        startRecording().catch((error) => setStatus(error.message || String(error), "error"));
      }
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
        reset.addEventListener("click", () => {
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
          <button class="secondary" data-loop-action="imitate">Imitate native</button>
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
        return;
      }
      const drillPracticeTrigger = event.target.closest && event.target.closest("[data-drill-practice]");
      if (drillPracticeTrigger) {
        const example = drillExampleFromTrigger(drillPracticeTrigger);
        startDrillPractice(example);
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
        return;
      }
      const trigger = event.target.closest && event.target.closest("[data-loop-action]");
      if (!trigger) return;
      const action = trigger.dataset.loopAction;
      if (action !== "imitate" && action !== "reply") return;
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
          "Native version",
          lastTurn.followUpQuestion || "",
        );
        vscode.postMessage({ type: "clearReplyContext" });
      } else {
        pendingReplyContext = null;
        pendingPracticeTarget = null;
        vscode.postMessage({ type: "clearReplyContext" });
      }
      const cta = $("record");
      if (cta && typeof cta.scrollIntoView === "function") {
        cta.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (!isRecording()) {
        startRecording().catch((error) => setStatus(error.message || String(error), "error"));
      }
    });
    document.addEventListener("click", (event) => {
      const actionTrigger = event.target.closest && event.target.closest("[data-action]");
      if (actionTrigger && actionTrigger.dataset.action === "today-tts") {
        const status = $("todayTtsStatus");
        if (status) status.textContent = "Generating example…";
        actionTrigger.disabled = true;
        vscode.postMessage({ type: "todayTts" });
        return;
      }
      const hybridTrigger = event.target.closest && event.target.closest("#useRecommendedHybrid");
      if (hybridTrigger) {
        vscode.postMessage({ type: "useRecommendedHybrid" });
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
        setStatus("Listening… speak now.");
      }
      if (message.type === "stage") {
        if (message.show) showStages(true);
        if (message.stage) setStage(message.stage, message.status || "active");
      }
      if (message.type === "practiceResult") {
        markAllStagesDone();
        setBusy(false);
	        setStatus("Ready ✓");
	        recorderMode = null;
	        pendingReplyContext = null;
	        pendingPracticeTarget = null;
	        activeRecordingTarget = null;
        if (message.result && message.result.localAudioUri) {
          $("localAudio").src = message.result.localAudioUri;
          $("localAudio").hidden = false;
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
        if (message.result && message.result.text) {
          pendingPracticeTarget = practiceTarget(message.result.text, "Example text", "");
        } else if (currentExampleText) {
          pendingPracticeTarget = practiceTarget(currentExampleText, "Example text", "");
        }
        if (status) {
          status.textContent = message.result && message.result.provider
            ? "Example generated with " + message.result.provider + " · next recording shadows this text"
            : "Example generated";
        }
        const button = document.querySelector('[data-action="today-tts"]');
        if (button) button.disabled = false;
      }
      if (message.type === "error") {
        if (recorderMode === "native") {
          recorderMode = null;
          setRecording(false);
        }
        stopVuMeter();
        stopTimer();
        setBusy(false);
        const todayButton = document.querySelector('[data-action="today-tts"]');
        if (todayButton) todayButton.disabled = false;
        showStages(false);
        setStatus(message.message || "Error.", "error");
      }
    });

    vscode.postMessage({ type: "ready" });
