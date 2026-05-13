(function () {
  'use strict';

  // ====== Password gate ======
  // Low-friction gate: keeps the page out of casual indexing.
  // Not real security. Password = "nctl" (per request).
  const PASSWORD = 'nctl';
  const GATE_KEY = 'nctl-food-safety-gate';

  function showGate() {
    const gate = document.createElement('div');
    gate.className = 'gate';
    gate.dataset.open = 'true';
    gate.innerHTML = ''
      + '<div class="gate-inner">'
      +   '<h1>NCTL Food Safety Services</h1>'
      +   '<p>Internal strategy brief for executive review. Enter the password Adam shared with you.</p>'
      +   '<input id="gatePwd" type="password" placeholder="password" autocomplete="off" autofocus>'
      +   '<button id="gateBtn">Continue</button>'
      +   '<div class="gate-err" id="gateErr"></div>'
      + '</div>';
    document.body.appendChild(gate);

    const input = document.getElementById('gatePwd');
    const btn = document.getElementById('gateBtn');
    const err = document.getElementById('gateErr');

    function tryUnlock() {
      if (input.value === PASSWORD) {
        try { localStorage.setItem(GATE_KEY, '1'); } catch (e) {}
        gate.dataset.open = 'false';
        setTimeout(function () { gate.remove(); }, 50);
      } else {
        err.textContent = 'Nope. Try again.';
        input.value = '';
        input.focus();
      }
    }
    btn.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') tryUnlock();
    });
  }

  function checkGate() {
    try {
      if (localStorage.getItem(GATE_KEY) === '1') return true;
    } catch (e) {}
    showGate();
    return false;
  }
  checkGate();

  // ====== Decisions ======
  // Same nine decisions across all three content pages.
  // localStorage syncs answers so checking on /recommendation persists to /options and /decisions.
  const STORAGE_KEY = 'nctl-food-safety-decisions';

  const DECISIONS = [
    {
      id: 'd1', num: 1,
      title: 'Posture',
      options: {
        go: 'Go — build the Food Safety Services line now.',
        survey: 'Wait — survey customer demand first, decide in 60 days.',
        partner: 'Partner out — refer to Bia Diagnostics / Eurofins for 6 months, then revisit.'
      }
    },
    {
      id: 'd2', num: 2,
      title: 'Capex authorization',
      options: {
        low: '~$25K — entry capex (mid-tier plate reader, manual washer, basic homogenizer).',
        mid: '~$50K — full capex (auto plate washer, premium homogenizer, second pipette set, contingency).',
        hold: 'Hold capex until demand signal validates.'
      }
    },
    {
      id: 'd3', num: 3,
      title: 'Analytical method for allergen testing',
      options: {
        elisa: 'ELISA only — R-Biopharm RIDASCREEN line, AOAC 2012.01 safe harbor.',
        both: 'ELISA primary + LC-MS/MS allergen method development for hydrolyzed/fermented matrices.',
        lcms: 'LC-MS/MS only — skip ELISA, build on existing LC-MS infrastructure.'
      }
    },
    {
      id: 'd4', num: 4,
      title: 'Services scope',
      options: {
        testing: 'Allergen testing only (samples in, results out).',
        swabs: '+ On-site sanitation/swab programs.',
        consulting: '+ Full food-safety consulting (cGMP, HACCP, PCQI, mock recalls, GFSI prep).',
        authenticity: 'All of the above + food-fraud / authenticity testing (oils, honey, syrup, spices, cannabis-product authenticity).'
      }
    },
    {
      id: 'd5', num: 5,
      title: 'Allergen panel phasing',
      options: {
        big9: 'Big 9 (gluten + peanut + tree nut + soy + milk + egg + fish + crustacean + sesame) from day one.',
        mvp: 'Gluten + peanut MVP, expand to Big 9 in 6 months.',
        pilot: 'Single-allergen pilot (gluten only) for 3 months, then scale.'
      }
    },
    {
      id: 'd6', num: 6,
      title: 'Authenticity beachhead',
      options: {
        cannabis: 'Cannabis-product authenticity first (terpenes, distillate, Delta-8 synthesis).',
        food: 'Conventional food authenticity first (olive oil, honey, maple syrup, spices).',
        both: 'Both in parallel.',
        skip: 'Skip authenticity for now — defer to year 2.'
      }
    },
    {
      id: 'd7', num: 7,
      title: 'Demand validation',
      options: {
        survey: 'Yes — formally survey existing edibles customers before greenlighting build.',
        proceed: 'No — proceed on conviction; the strategic case is clear enough.'
      }
    },
    {
      id: 'd8', num: 8,
      title: 'Staffing for on-site / consulting',
      options: {
        payroll: 'Hire PCQI-credentialed FTE on payroll.',
        contract: 'Use contract consultant at ~$200–400/hr until volume justifies FTE.',
        both: 'Both — junior FTE for routine work + senior contractor for audits.'
      }
    },
    {
      id: 'd9', num: 9,
      title: 'Branding',
      options: {
        subbrand: '"NCTL Food Safety" as a sub-brand of NCTL.',
        llc: 'Separate LLC — distinct liability + insurance vehicle.',
        expand: 'Just expand NCTL scope — no separate brand.'
      }
    }
  ];

  function loadState() {
    try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
    catch (e) { return {}; }
  }
  function saveState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  let state = loadState();

  function applyDecisionState(dec) {
    const sec = document.getElementById(dec.id);
    if (!sec) return;
    const s = state[dec.id] || {};
    if (s.choice) {
      const radio = sec.querySelector('input[type="radio"][value="' + s.choice + '"]');
      if (radio && !radio.checked) radio.checked = true;
    }
    const ta = sec.querySelector('textarea');
    if (ta && typeof s.notes === 'string' && ta.value !== s.notes) ta.value = s.notes;
    sec.dataset.answered = s.choice ? 'true' : 'false';
  }

  function bindDecision(dec) {
    const sec = document.getElementById(dec.id);
    if (!sec) return;
    sec.querySelectorAll('input[type="radio"][name="' + dec.id + '"]').forEach(function (r) {
      r.addEventListener('change', function () {
        state[dec.id] = state[dec.id] || {};
        state[dec.id].choice = r.value;
        saveState(state);
        applyDecisionState(dec);
        updateProgress();
      });
    });
    const ta = sec.querySelector('textarea');
    if (ta) {
      ta.addEventListener('input', function () {
        state[dec.id] = state[dec.id] || {};
        state[dec.id].notes = ta.value;
        saveState(state);
      });
    }
    applyDecisionState(dec);
  }

  function updateProgress() {
    let n = 0;
    DECISIONS.forEach(function (dec) {
      if ((state[dec.id] || {}).choice) n++;
    });
    const el = document.getElementById('progressCount');
    if (el) el.textContent = n;
  }

  function compileMarkdown() {
    const lines = [];
    lines.push('# NCTL Food Safety Services — Exec Decisions');
    lines.push('');
    lines.push('Reviewed: ' + new Date().toISOString());
    lines.push('');

    let answered = 0, pending = 0;
    DECISIONS.forEach(function (dec) {
      if ((state[dec.id] || {}).choice) answered++; else pending++;
    });
    lines.push('**Status:** ' + answered + ' of ' + DECISIONS.length + ' decided.');
    lines.push('');

    DECISIONS.forEach(function (dec) {
      const s = state[dec.id] || {};
      const choiceLabel = s.choice ? (dec.options[s.choice] || s.choice) : '_(not yet decided)_';
      lines.push('## Decision ' + dec.num + ' — ' + dec.title);
      lines.push('');
      lines.push('**Chosen:** ' + choiceLabel);
      if (s.notes && s.notes.trim()) {
        lines.push('');
        lines.push('**Notes:**');
        lines.push('');
        s.notes.trim().split(/\r?\n/).forEach(function (ln) { lines.push('> ' + ln); });
      }
      lines.push('');
    });

    if (pending > 0) {
      lines.push('---');
      lines.push('');
      lines.push('**Outstanding:** ' + pending + ' decision' + (pending === 1 ? '' : 's') + ' not yet picked.');
      lines.push('');
    }

    return lines.join('\n');
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.dataset.show = 'true';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.dataset.show = 'false'; }, 2200);
  }

  function wireModal() {
    const modal = document.getElementById('modal');
    const modalOutput = document.getElementById('modalOutput');
    if (!modal || !modalOutput) return;

    function openModal() {
      modalOutput.textContent = compileMarkdown();
      modal.dataset.open = 'true';
      document.body.style.overflow = 'hidden';
    }
    function closeModal() {
      modal.dataset.open = 'false';
      document.body.style.overflow = '';
    }

    const btnCompile = document.getElementById('btnCompile');
    const btnCompileBottom = document.getElementById('btnCompileBottom');
    if (btnCompile) btnCompile.addEventListener('click', openModal);
    if (btnCompileBottom) btnCompileBottom.addEventListener('click', openModal);
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('btnCloseFooter').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.dataset.open === 'true') closeModal();
    });

    document.getElementById('btnCopy').addEventListener('click', function () {
      const text = modalOutput.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { showToast('Copied to clipboard'); },
          function () { fallbackCopy(text); }
        );
      } else { fallbackCopy(text); }
    });
    function fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); showToast('Copied to clipboard'); }
      catch (e) { showToast('Copy failed — select manually'); }
      document.body.removeChild(ta);
    }
    document.getElementById('btnDownload').addEventListener('click', function () {
      const text = compileMarkdown();
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url; a.download = 'nctl-food-safety-decisions-' + ts + '.md';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 500);
      showToast('Downloaded');
    });
    const btnReset = document.getElementById('btnReset');
    if (btnReset) btnReset.addEventListener('click', function () {
      if (!confirm('Clear all decisions? This cannot be undone.')) return;
      state = {}; saveState(state);
      DECISIONS.forEach(applyDecisionState);
      document.querySelectorAll('input[type="radio"]').forEach(function (r) { r.checked = false; });
      document.querySelectorAll('.decision textarea').forEach(function (t) { t.value = ''; });
      document.querySelectorAll('.decision').forEach(function (s) { s.dataset.answered = 'false'; });
      updateProgress();
      showToast('All decisions cleared');
    });
  }

  // Init after DOM ready (script is at end of body so DOM is parsed).
  DECISIONS.forEach(bindDecision);
  updateProgress();
  wireModal();

  // Re-hydrate when the user navigates back from a sibling page (localStorage changed elsewhere).
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) {
      state = loadState();
      DECISIONS.forEach(applyDecisionState);
      updateProgress();
    }
  });

  // Expose for landing-page progress counter
  window.__NCTLFS = { state: state, decisionCount: DECISIONS.length, decisions: DECISIONS };
})();
