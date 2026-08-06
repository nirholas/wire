/**
 * The web client.
 *
 * It consumes the same SSE stream the Telegram bot consumes, and renders the
 * same progressive story: lanes light up as they run, the first usable text
 * replaces the skeleton, and the read replaces the text. Nothing blocks on the
 * slowest lane.
 */

const LANES = ['tweet', 'subscription', 'direct', 'reader', 'siblings', 'primary', 'wayback', 'archive'];

const LANE_COPY = {
  tweet: 'the post',
  subscription: 'your subscription',
  direct: 'the outlet',
  reader: 'reader view',
  siblings: 'independent coverage',
  primary: 'the primary source',
  wayback: 'archived snapshot',
  archive: 'archived snapshot'
};

const form = document.getElementById('form');
const input = document.getElementById('url');
const button = document.getElementById('go');
const lanesEl = document.getElementById('lanes');
const resultEl = document.getElementById('result');
const emptyEl = document.getElementById('empty');
const recentEl = document.getElementById('recent');
const recentList = document.getElementById('recent-list');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');

let stream = null;

const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
};

/* ---------------------------------------------------------------- lanes ---- */

function paintLanes(state) {
  lanesEl.replaceChildren(
    ...LANES.map((lane) => {
      const li = document.createElement('li');
      li.textContent = lane;
      li.title = LANE_COPY[lane] || lane;
      if (state.winner === lane) li.className = 'won';
      else if (state.finished.has(lane)) li.className = state.failed.has(lane) ? 'failed' : 'done';
      else if (state.started) li.className = 'running';
      return li;
    })
  );
}

/* --------------------------------------------------------------- render ---- */

function skeleton() {
  return `
    <div class="route"><span class="tag">resolving</span></div>
    <div class="skeleton title"></div>
    <div class="skeleton line"></div>
    <div class="skeleton line" style="width:88%"></div>
    <div class="skeleton line" style="width:64%"></div>`;
}

function renderRoute(state) {
  const tags = [];
  const route = state.result?.route || state.candidate?.lane;
  const outlet = state.result?.outlet || state.candidate?.outlet || state.outlet?.name;

  if (outlet) tags.push(`<span class="tag">${escape(outlet)}</span>`);

  const gated = state.result?.gated ?? state.expectGated;
  if (gated) {
    const kind = state.result?.access?.kind || 'gated';
    tags.push(`<span class="tag gated">${escape(kind)} wall</span>`);
  }
  if (route) {
    const via = LANE_COPY[route] || route;
    tags.push(`<span class="tag win">via ${escape(via)}</span>`);
  }
  if (state.haveSubscription) tags.push('<span class="tag">session loaded</span>');
  if (state.candidate?.snapshot) {
    tags.push(`<span class="tag">snapshot ${escape(state.candidate.snapshot.slice(0, 10))}</span>`);
  }
  return `<div class="route">${tags.join('')}</div>`;
}

function renderSummary(summary) {
  const parts = [];
  parts.push(`<h2>${escape(summary.headline)}</h2>`);
  if (summary.what_changed) parts.push(`<p class="lede">${escape(summary.what_changed)}</p>`);
  if (summary.why_it_matters) parts.push(`<p class="why">${escape(summary.why_it_matters)}</p>`);

  if (summary.assets?.length) {
    parts.push(
      `<ul class="assets">${summary.assets
        .map(
          (asset) =>
            `<li class="${escape(asset.direction)}" title="${escape(asset.why)}">` +
            `<span class="sym">${escape(asset.symbol)}</span>` +
            `<span>${{ bullish: '▲', bearish: '▼', mixed: '↔', neutral: '·' }[asset.direction] || '·'}</span>` +
            `<span>${escape(asset.exposure)}</span></li>`
        )
        .join('')}</ul>`
    );
  }

  parts.push(
    `<div class="meta-row">` +
      `<span>${escape(summary.status)}</span>` +
      `<span>${escape(summary.priced_in)} priced in</span>` +
      `<span>${escape(summary.horizon)}</span>` +
      (summary.status_note ? `<span>${escape(summary.status_note)}</span>` : '') +
      `</div>`
  );

  if (summary.numbers?.length) {
    parts.push(`<ul class="numbers">${summary.numbers.map((n) => `<li>${escape(n)}</li>`).join('')}</ul>`);
  }
  if (summary.counter) {
    parts.push(`<p class="counter"><b>Counter:</b> ${escape(summary.counter)}</p>`);
  }
  return parts.join('');
}

function render(state) {
  if (!state.candidate && !state.result && !state.post) {
    resultEl.innerHTML = skeleton();
    return;
  }

  const parts = [renderRoute(state)];

  if (state.post) {
    parts.push(
      `<div class="notice"><b>${escape(state.post.author)}</b><br>${escape(state.post.text)}</div>`
    );
  }

  const summary = state.result?.summary || state.summary;
  if (summary) {
    parts.push(renderSummary(summary));
  } else if (state.candidate) {
    parts.push(`<h2>${escape(state.candidate.title || 'Resolving…')}</h2>`);
    parts.push(`<p class="lede">${escape(state.candidate.excerpt)}</p>`);
    if (state.llmEnabled !== false) parts.push('<div class="skeleton line" style="width:55%"></div>');
  }

  const summaryError = state.result?.summaryError || state.summaryError;
  if (summaryError && !summary) {
    parts.push(`<p class="notice warn">No read: ${escape(summaryError)}</p>`);
  }

  const coverage = state.result?.coverage || [];
  if (coverage.length > 1) {
    parts.push(
      `<p class="coverage">Also running it: ` +
        coverage
          .slice(0, 6)
          .map((entry) =>
            entry.url
              ? `<a href="${escape(entry.url)}" target="_blank" rel="noopener">${escape(entry.outlet)}</a>`
              : escape(entry.outlet)
          )
          .join(', ') +
        `</p>`
    );
  }

  const text = state.result?.text || '';
  if (text) {
    parts.push(
      `<details class="body"><summary>Full text (${text.length.toLocaleString()} chars)</summary>` +
        `<div class="text">${(state.result.paragraphs || [text])
          .map((p) => `<p>${escape(p)}</p>`)
          .join('')}</div></details>`
    );
  }

  const foot = [];
  const sourceUrl = state.result?.sourceUrl || state.candidate?.url;
  if (sourceUrl) foot.push(`<a href="${escape(sourceUrl)}" target="_blank" rel="noopener">source · ${escape(host(sourceUrl))}</a>`);
  if (state.target && state.target !== sourceUrl) {
    foot.push(`<a href="${escape(state.target)}" target="_blank" rel="noopener">original · ${escape(host(state.target))}</a>`);
  }
  if (state.result?.permalink) foot.push(`<a href="${escape(state.result.permalink)}">permalink</a>`);
  if (state.elapsedMs) foot.push(`${(state.elapsedMs / 1000).toFixed(2)}s`);
  if (state.result?.summaryMeta?.provider) foot.push(escape(state.result.summaryMeta.provider));
  if (state.result?.cached) foot.push('cached');
  if (foot.length) parts.push(`<div class="foot">${foot.join('')}</div>`);

  resultEl.innerHTML = parts.join('');
}

/* --------------------------------------------------------------- stream ---- */

function run(url) {
  stream?.close();

  const state = {
    started: true,
    finished: new Set(),
    failed: new Set(),
    winner: null,
    target: url
  };

  emptyEl.hidden = true;
  resultEl.hidden = false;
  button.disabled = true;
  button.querySelector('.go-label').textContent = 'Resolving';
  paintLanes(state);
  render(state);

  stream = new EventSource(`/api/resolve/stream?url=${encodeURIComponent(url)}`);

  const finish = () => {
    stream?.close();
    stream = null;
    button.disabled = false;
    button.querySelector('.go-label').textContent = 'Resolve';
    state.started = false;
    paintLanes(state);
    loadRecent();
  };

  const on = (event, handler) =>
    stream.addEventListener(event, (message) => {
      try {
        handler(JSON.parse(message.data));
      } catch {
        /* a malformed frame should not kill the stream */
      }
    });

  on('post', (data) => {
    state.post = data.post;
    state.finished.add('tweet');
    state.winner = state.winner || 'tweet';
    state.elapsedMs = data.elapsedMs;
    paintLanes(state);
    render(state);
  });

  on('target', (data) => {
    state.target = data.target;
    state.outlet = data.outlet;
    state.expectGated = data.expectGated;
    state.haveSubscription = data.haveSubscription;
    render(state);
  });

  on('text', (data) => {
    state.candidate = data.candidate;
    state.winner = data.lane;
    state.finished.add(data.lane);
    state.elapsedMs = data.elapsedMs;
    paintLanes(state);
    render(state);
  });

  on('summary', (data) => {
    state.summary = data.summary;
    state.elapsedMs = data.elapsedMs;
    render(state);
  });

  on('summary_failed', (data) => {
    state.summaryError = data.error;
    render(state);
  });

  const done = (data) => {
    state.result = data.result;
    state.elapsedMs = data.result?.elapsedMs || state.elapsedMs;
    for (const lane of data.result?.lanes || []) {
      state.finished.add(lane.lane);
      if (!lane.ok) state.failed.add(lane.lane);
    }
    state.winner = data.result?.route || state.winner;
    paintLanes(state);
    render(state);
  };
  on('done', done);
  on('cached', done);

  on('error', (data) => {
    resultEl.innerHTML = `<p class="notice error">${escape(data.error || 'Resolution failed.')}</p>`;
    finish();
  });

  stream.addEventListener('end', finish);
  stream.onerror = () => {
    // EventSource fires onerror on normal stream close too; only surface it if
    // nothing ever arrived.
    if (!state.result && !state.candidate && !state.post) {
      resultEl.innerHTML = '<p class="notice error">Lost connection to the server.</p>';
    }
    finish();
  };
}

/* --------------------------------------------------------------- chrome ---- */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  history.replaceState(null, '', `/?url=${encodeURIComponent(url)}`);
  run(url);
});

// Cmd/Ctrl+K focuses the input from anywhere, the way every fast tool does it.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    input.focus();
    input.select();
  }
});

async function loadRecent() {
  try {
    const res = await fetch('/api/recent?limit=12');
    if (!res.ok) return;
    const { items } = await res.json();
    if (!items?.length) return;
    recentEl.hidden = false;
    recentList.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement('li');
        li.innerHTML =
          `<a href="/?url=${encodeURIComponent(item.url)}">` +
          `<span>${escape(item.summary || item.title || item.url)}</span>` +
          `<span class="r-outlet">${escape(item.outlet || host(item.url))}</span></a>`;
        return li;
      })
    );
  } catch {
    /* recent is a nicety, never an error surface */
  }
}

async function loadStatus() {
  try {
    const res = await fetch('/healthz');
    const data = await res.json();
    const hasLlm = data.llm?.configured;
    statusEl.className = `status ${hasLlm ? 'ok' : 'degraded'}`;
    statusText.textContent = hasLlm
      ? `${data.llm.chain.length} model${data.llm.chain.length === 1 ? '' : 's'} · ${data.lanes.length} lanes`
      : `${data.lanes.length} lanes · no model`;
    if (!hasLlm) statusEl.title = 'No LLM key configured. wire returns text without a read.';
  } catch {
    statusEl.className = 'status down';
    statusText.textContent = 'offline';
  }
}

// Deep link support: /?url=... resolves on load, and /r/<id> loads a permalink.
const params = new URLSearchParams(location.search);
const preset = params.get('url');
if (preset) {
  input.value = preset;
  run(preset);
} else if (location.pathname.startsWith('/r/')) {
  fetch(location.pathname, { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((stored) => {
      if (!stored) return;
      emptyEl.hidden = true;
      resultEl.hidden = false;
      input.value = stored.url;
      render({ result: stored, target: stored.target, elapsedMs: stored.elapsedMs, finished: new Set(), failed: new Set() });
    })
    .catch(() => {});
}

loadStatus();
loadRecent();
