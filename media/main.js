// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const askForm = document.getElementById('ask-form');
  const questionInput = /** @type {HTMLInputElement} */ (document.getElementById('question-input'));
  const askBtn = /** @type {HTMLButtonElement} */ (document.getElementById('ask-btn'));
  const statusEl = document.getElementById('status');
  const cancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById('cancel-btn'));
  const summaryEl = document.getElementById('summary');
  const stepPanelEl = document.getElementById('step-panel');
  const stepProgressEl = document.getElementById('step-progress');
  const stepWarningEl = document.getElementById('step-warning');
  const stepTitleEl = document.getElementById('step-title');
  const stepExplanationEl = document.getElementById('step-explanation');
  const snapshotEl = /** @type {HTMLDetailsElement} */ (document.getElementById('step-snapshot'));
  const snapshotCodeEl = document.getElementById('step-snapshot-code');
  const prevBtn = /** @type {HTMLButtonElement} */ (document.getElementById('prev-btn'));
  const nextBtn = /** @type {HTMLButtonElement} */ (document.getElementById('next-btn'));
  const endBtn = /** @type {HTMLButtonElement} */ (document.getElementById('end-btn'));
  const outlineEl = document.getElementById('outline');
  const welcomeEl = document.getElementById('welcome');
  const progressTrackEl = document.getElementById('progress-track');
  const progressBarEl = document.getElementById('progress-bar');
  const filemapSectionEl = document.getElementById('filemap-section');
  const filemapRowsEl = document.getElementById('filemap-rows');
  const filemapMarkerEl = document.getElementById('filemap-marker');

  /** file path -> its row element, so the marker can find where to travel to. */
  let fileRows = new Map();

  function splitPath(p) {
    const parts = String(p).split(/[\\/]/);
    return { dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
  }

  /**
   * Build a map of the files this tour visits, in the order it first reaches them,
   * grouped under their directory. The point is to make the shape of the codebase
   * legible - which folders are involved, and how the tour moves between them.
   */
  function renderFileMap() {
    filemapRowsEl.textContent = '';
    fileRows = new Map();
    if (!state.plan) {
      filemapSectionEl.hidden = true;
      return;
    }

    const order = [];
    const stepsByFile = new Map();
    state.plan.steps.forEach((step, i) => {
      if (!stepsByFile.has(step.file)) {
        stepsByFile.set(step.file, []);
        order.push(step.file);
      }
      stepsByFile.get(step.file).push(i);
    });

    let lastDir = null;
    for (const file of order) {
      const { dir, name } = splitPath(file);
      if (dir !== lastDir) {
        const dirEl = document.createElement('div');
        dirEl.className = 'fm-dir';
        dirEl.textContent = dir || '(root)';
        filemapRowsEl.appendChild(dirEl);
        lastDir = dir;
      }

      const row = document.createElement('div');
      row.className = 'fm-file';
      row.dataset.file = file;

      const nameEl = document.createElement('span');
      nameEl.className = 'fm-name';
      nameEl.textContent = name;
      row.appendChild(nameEl);

      const dots = document.createElement('span');
      dots.className = 'fm-dots';
      for (const stepIndex of stepsByFile.get(file)) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'fm-dot';
        dot.dataset.step = String(stepIndex);
        dot.title = state.plan.steps[stepIndex].title;
        dot.textContent = String(stepIndex + 1);
        dot.addEventListener('click', () => vscode.postMessage({ type: 'goto', index: stepIndex }));
        dots.appendChild(dot);
      }
      row.appendChild(dots);

      filemapRowsEl.appendChild(row);
      fileRows.set(file, row);
    }

    filemapSectionEl.hidden = false;
  }

  /** Slide the marker to the file the current step lives in. */
  function updateFileMap() {
    if (!state.plan) {
      return;
    }
    const step = state.plan.steps[state.index];
    if (!step) {
      return;
    }

    for (const [file, row] of fileRows) {
      row.classList.toggle('is-current', file === step.file);
    }
    for (const dot of filemapRowsEl.querySelectorAll('.fm-dot')) {
      dot.classList.toggle('is-current', Number(dot.dataset.step) === state.index);
    }

    const row = fileRows.get(step.file);
    if (!row) {
      filemapMarkerEl.style.opacity = '0';
      return;
    }
    // Travelling to the row's offset is what makes a jump between files visible as
    // movement rather than as two unrelated highlight states.
    filemapMarkerEl.style.opacity = '1';
    filemapMarkerEl.style.transform = `translateY(${row.offsetTop}px)`;
    filemapMarkerEl.style.height = `${row.offsetHeight}px`;
  }

  const state = { plan: null, index: 0, resolution: 'exact', note: '' };

  let elapsedTimer = null;
  let startedAt = 0;

  function stopTimer() {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function startTimer(question) {
    stopTimer();
    startedAt = Date.now();
    const tick = () => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      statusEl.textContent = `Exploring the codebase… ${secs}s · "${question}"`;
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  }

  function setBusy(busy) {
    askBtn.disabled = busy;
    questionInput.disabled = busy;
    cancelBtn.hidden = !busy;
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', Boolean(isError));
  }

  function renderIdle() {
    stopTimer();
    state.plan = null;
    state.index = 0;
    setStatus('', false);
    summaryEl.textContent = '';
    stepPanelEl.classList.remove('is-visible');
    stepTitleEl.textContent = '';
    stepExplanationEl.textContent = '';
    stepProgressEl.textContent = '';
    stepWarningEl.hidden = true;
    stepWarningEl.textContent = '';
    snapshotEl.hidden = true;
    snapshotEl.open = false;
    snapshotCodeEl.textContent = '';
    outlineEl.textContent = '';
    welcomeEl.hidden = false;
    progressTrackEl.hidden = true;
    progressBarEl.style.width = '0%';
    filemapSectionEl.hidden = true;
    filemapRowsEl.textContent = '';
    fileRows = new Map();
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    endBtn.disabled = true;
    setBusy(false);
  }

  function renderOutline() {
    outlineEl.textContent = '';
    if (!state.plan) {
      return;
    }
    state.plan.steps.forEach((step, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'outline-item' + (i === state.index ? ' is-current' : '');
      btn.setAttribute('aria-current', i === state.index ? 'true' : 'false');

      const num = document.createElement('span');
      num.className = 'outline-num';
      num.textContent = String(i + 1);

      const label = document.createElement('span');
      label.className = 'outline-label';
      label.textContent = step.title;

      btn.appendChild(num);
      btn.appendChild(label);
      btn.addEventListener('click', () => vscode.postMessage({ type: 'goto', index: i }));
      outlineEl.appendChild(btn);
    });
  }

  function renderStep() {
    if (!state.plan) {
      return;
    }
    const step = state.plan.steps[state.index];
    if (!step) {
      return;
    }
    stepPanelEl.classList.add('is-visible');
    stepProgressEl.textContent = `Step ${state.index + 1} of ${state.plan.steps.length} · ${step.file}`;
    stepTitleEl.textContent = step.title;
    stepExplanationEl.textContent = step.explanation;

    progressTrackEl.hidden = false;
    progressBarEl.style.width = `${((state.index + 1) / state.plan.steps.length) * 100}%`;

    // Retrigger the enter animation: removing and re-adding in the same frame is
    // coalesced away, so force a reflow between the two.
    stepPanelEl.classList.remove('is-entering');
    void stepPanelEl.offsetWidth;
    stepPanelEl.classList.add('is-entering');

    // Anything but an exact hit has to be visible: a teaching tool that confidently
    // explains the wrong lines is worse than one that admits it lost its place.
    const trustworthy = state.resolution === 'exact';
    if (trustworthy) {
      stepWarningEl.hidden = true;
      stepWarningEl.textContent = '';
    } else {
      stepWarningEl.hidden = false;
      stepWarningEl.textContent = state.note || 'This step may not point at the right code.';
      stepWarningEl.className = state.resolution === 'relocated' ? 'is-warn' : 'is-bad';
    }

    // When we could not re-anchor, the highlight is untrustworthy but the snapshot
    // taken at generation time still shows what the explanation is actually about.
    const showSnapshot = !trustworthy && state.resolution !== 'relocated' && Boolean(step.snapshot);
    snapshotEl.hidden = !showSnapshot;
    snapshotCodeEl.textContent = showSnapshot ? step.snapshot : '';
    if (!showSnapshot) {
      snapshotEl.open = false;
    }

    prevBtn.disabled = state.index <= 0;
    nextBtn.disabled = state.index >= state.plan.steps.length - 1;
    endBtn.disabled = false;
    renderOutline();
    updateFileMap();
  }

  askForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = questionInput.value.trim();
    if (!question) {
      return;
    }
    vscode.postMessage({ type: 'ask', question });
  });

  // One-click starters, so the panel is usable without thinking up a question.
  for (const btn of document.querySelectorAll('.suggestion')) {
    btn.addEventListener('click', () => {
      const question = btn.textContent.trim();
      questionInput.value = question;
      vscode.postMessage({ type: 'ask', question });
    });
  }

  prevBtn.addEventListener('click', () => vscode.postMessage({ type: 'prev' }));
  nextBtn.addEventListener('click', () => vscode.postMessage({ type: 'next' }));
  endBtn.addEventListener('click', () => vscode.postMessage({ type: 'end' }));
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  // Arrow-key stepping, as long as the user isn't typing a question.
  document.addEventListener('keydown', (e) => {
    if (document.activeElement === questionInput || !state.plan) {
      return;
    }
    if (e.key === 'ArrowRight') {
      vscode.postMessage({ type: 'next' });
    } else if (e.key === 'ArrowLeft') {
      vscode.postMessage({ type: 'prev' });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'focusInput':
        if (typeof msg.prefill === 'string' && msg.prefill) {
          questionInput.value = msg.prefill;
        }
        questionInput.focus();
        questionInput.select();
        break;
      case 'loading':
        setBusy(true);
        startTimer(msg.question);
        summaryEl.textContent = '';
        welcomeEl.hidden = true;
        progressTrackEl.hidden = true;
        stepPanelEl.classList.remove('is-visible');
        outlineEl.textContent = '';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        endBtn.disabled = true;
        break;
      case 'error':
        stopTimer();
        setBusy(false);
        setStatus(msg.message, true);
        break;
      case 'plan': {
        stopTimer();
        setBusy(false);
        state.plan = msg.plan;
        state.index = msg.index;
        state.resolution = 'exact';
        state.note = '';
        // A tour costs real money (measured ~$0.40 on a mid-size repo), so show it
        // rather than quietly spending on the user's behalf.
        const bits = [];
        if (typeof msg.plan.durationMs === 'number') {
          bits.push(`${Math.round(msg.plan.durationMs / 1000)}s`);
        }
        if (typeof msg.plan.costUsd === 'number') {
          bits.push(`$${msg.plan.costUsd.toFixed(2)}`);
        }
        setStatus(bits.length ? `Tour ready · ${bits.join(' · ')}` : '', false);
        summaryEl.textContent = msg.plan.summary;
        welcomeEl.hidden = true;
        renderFileMap();
        renderStep();
        break;
      }
      case 'step':
        state.index = msg.index;
        state.resolution = msg.resolution || 'exact';
        state.note = msg.note || '';
        renderStep();
        break;
      case 'idle':
        renderIdle();
        break;
    }
  });

  renderIdle();
  vscode.postMessage({ type: 'ready' });
})();
