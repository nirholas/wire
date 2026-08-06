/**
 * Message rendering.
 *
 * The constraint that shapes everything here: this message gets EDITED IN PLACE
 * three or four times as the answer sharpens, so the layout has to stay stable
 * between renders. Blocks appear and fill in; nothing jumps around. A reader
 * glancing back at the same message ten seconds later should find the same
 * shape with more in it.
 */

const LANE_LABEL = {
  subscription: 'your subscription',
  direct: 'the outlet',
  reader: 'reader view',
  siblings: 'independent coverage',
  primary: 'the primary source',
  wayback: 'an archived snapshot',
  archive: 'an archived snapshot',
  tweet: 'the post'
};

const DIRECTION_MARK = {
  bullish: '▲',
  bearish: '▼',
  mixed: '↔',
  neutral: '·'
};

const STATUS_MARK = {
  confirmed: 'confirmed',
  reported: 'reported',
  rumored: 'rumor',
  opinion: 'opinion'
};

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(value, max) {
  const text = String(value || '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Renders the current state of a resolution.
 * @param {object} state accumulated from the resolve() update stream
 */
export function renderMessage(state) {
  const lines = [];
  const {
    stage,
    target,
    outlet,
    expectGated,
    haveSubscription,
    post,
    candidate,
    summary,
    summaryError,
    result,
    elapsedMs,
    provider
  } = state;

  /* Header: where we are reading from, and whether we had to route around a wall. */
  const outletName = result?.outlet || candidate?.outlet || outlet?.name || hostOf(target) || '';
  const lane = result?.route || candidate?.lane || '';
  const gated = result?.gated ?? expectGated;

  const header = [];
  if (outletName) header.push(`<b>${escapeHtml(outletName)}</b>`);
  if (gated && lane && lane !== 'direct' && lane !== 'subscription') {
    header.push(`gated → read via ${LANE_LABEL[lane] || lane}`);
  } else if (lane === 'subscription') {
    header.push('read with your subscription');
  } else if (lane && LANE_LABEL[lane]) {
    header.push(`via ${LANE_LABEL[lane]}`);
  } else if (gated) {
    header.push('gated');
  }
  if (header.length) lines.push(header.join(' · '));

  /* The post that surfaced it, when there was one. */
  if (post?.text) {
    lines.push('');
    lines.push(`<b>${escapeHtml(post.author || 'post')}</b>`);
    lines.push(`<i>${escapeHtml(truncate(post.text, 420))}</i>`);
  }

  /* The read. */
  if (summary) {
    lines.push('');
    if (summary.headline) lines.push(`<b>${escapeHtml(summary.headline)}</b>`);
    if (summary.what_changed) {
      lines.push('');
      lines.push(escapeHtml(summary.what_changed));
    }
    if (summary.why_it_matters) {
      lines.push('');
      lines.push(escapeHtml(summary.why_it_matters));
    }

    if (summary.assets?.length) {
      const assets = summary.assets
        .slice(0, 5)
        .map((asset) => `${DIRECTION_MARK[asset.direction] || '·'} <b>${escapeHtml(asset.symbol)}</b>`)
        .join('  ');
      lines.push('');
      lines.push(assets);
    }

    const meta = [
      STATUS_MARK[summary.status] || summary.status,
      `${summary.priced_in} priced in`,
      summary.horizon
    ].filter(Boolean);
    lines.push(`<code>${escapeHtml(meta.join('  ·  '))}</code>`);

    if (summary.numbers?.length) {
      lines.push('');
      for (const number of summary.numbers.slice(0, 4)) {
        lines.push(`• ${escapeHtml(truncate(number, 120))}`);
      }
    }

    if (summary.counter) {
      lines.push('');
      lines.push(`<b>Counter:</b> ${escapeHtml(truncate(summary.counter, 300))}`);
    }
  } else if (candidate?.excerpt) {
    // Text is in but the read has not landed yet. Show the text.
    lines.push('');
    lines.push(escapeHtml(truncate(candidate.excerpt, 500)));
  } else if (post?.text) {
    // Nothing beyond the post yet; the post block above is already the content.
  } else {
    lines.push('');
    lines.push('<i>resolving…</i>');
  }

  if (summaryError && !summary) {
    lines.push('');
    lines.push(`<i>No read: ${escapeHtml(truncate(summaryError, 140))}</i>`);
  }

  /* Who else ran it. This is the sibling lane showing its work. */
  const coverage = result?.coverage || [];
  if (coverage.length > 1) {
    const outlets = [...new Set(coverage.map((entry) => entry.outlet).filter(Boolean))].slice(0, 5);
    if (outlets.length > 1) {
      lines.push('');
      lines.push(`<i>Also running it: ${escapeHtml(outlets.join(', '))}</i>`);
    }
  }

  /* Footer: links and timing. */
  const footer = [];
  const readUrl = result?.sourceUrl || candidate?.url || target;
  if (readUrl) footer.push(`<a href="${escapeHtml(readUrl)}">source</a>`);
  if (target && readUrl !== target) footer.push(`<a href="${escapeHtml(target)}">original</a>`);

  const timing = [];
  if (elapsedMs) timing.push(`${(elapsedMs / 1000).toFixed(1)}s`);
  if (provider) timing.push(provider);
  if (stage && stage !== 'done') timing.push(`${stage}…`);

  if (footer.length || timing.length) {
    lines.push('');
    lines.push(`${footer.join(' · ')}${footer.length && timing.length ? '  ' : ''}<code>${escapeHtml(timing.join(' · '))}</code>`);
  }

  // Telegram hard-caps a message at 4096 characters.
  const out = lines.join('\n');
  return out.length > 4000 ? `${out.slice(0, 3990)}…` : out;
}

export function renderHelp() {
  return [
    '<b>wire</b> resolves a news link to the trade.',
    '',
    'Send me any link. I race every route at once and edit this message as the answer sharpens:',
    '',
    '• <b>the post</b> if it is an X link, instantly',
    '• <b>the article</b> if the outlet serves it',
    '• <b>your subscription</b> if you loaded cookies for that outlet',
    '• <b>independent coverage</b> when the original is gated',
    '• <b>the primary source</b>: the filing, the announcement, the release',
    '• <b>an archived snapshot</b> if one already exists',
    '',
    'Then a trading read: what changed, what it touches, is it confirmed, and the strongest counter-argument.',
    '',
    '<b>Commands</b>',
    '/health - which lanes and models are live',
    '/help - this'
  ].join('\n');
}

export { LANE_LABEL, truncate, hostOf };
