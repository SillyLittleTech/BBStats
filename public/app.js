const statusMessage = document.getElementById('status-message');
const tableBody = document.querySelector('#blocked-table tbody');
const refreshButton = document.getElementById('refresh-button');
const rangeSelect = document.getElementById('range-select');
const chartContext = document.getElementById('traffic-chart').getContext('2d');

let chartInstance = null;
let currentRange = rangeSelect?.value || '7d';
let currentFetchController = null;
let inFlightRange = null;
let cacheStatus = {
  lastLoadedRange: null,
  lastFetchedAt: null,
  isFromCache: false,
};

const rangeLabels = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '365d': 'Last 365 days',
  lifetime: 'All available data',
  latest: 'Latest 1000 records',
};

// viewMode: 'blocked' | 'allowed'
let viewMode = 'blocked';
const viewSelect = document.getElementById('view-select');
const countHeader = document.getElementById('count-header');

if (viewSelect) {
  viewSelect.addEventListener('change', () => {
    viewMode = viewSelect.value || 'blocked';
    if (countHeader) countHeader.textContent = viewMode === 'blocked' ? 'Blocked Count' : 'Request Count';
    loadSummary(rangeSelect?.value || currentRange);
  });
}

// Advanced debugging panel (show/hide)
const advancedToggle = document.getElementById('advanced-toggle');
const advancedPanel = document.getElementById('advanced-panel');
const rangeSelectDebug = document.getElementById('range-select-debug');
const refreshButtonDebug = document.getElementById('refresh-button-debug');

if (advancedToggle && advancedPanel) {
  advancedToggle.addEventListener('click', () => {
    const isVisible = advancedPanel.style.display !== 'none';
    advancedPanel.style.display = isVisible ? 'none' : 'block';
    advancedToggle.textContent = isVisible ? 'Show advanced debugging' : 'Hide advanced debugging';
  });
}

if (rangeSelectDebug) {
  rangeSelectDebug.addEventListener('change', () => {
    // change the hidden rangeSelect value used by the loader
    if (rangeSelect) rangeSelect.value = rangeSelectDebug.value;
    loadSummary(rangeSelectDebug.value, { triggeredByUser: true });
  });
}

if (refreshButtonDebug) {
  refreshButtonDebug.addEventListener('click', () => loadSummary(rangeSelect?.value || currentRange, { forceRefresh: true, triggeredByUser: true }));
}

function setStatus(message, variant) {
  statusMessage.textContent = message;
  statusMessage.classList.remove('status--success', 'status--error', 'status--loading');
  if (variant) {
    statusMessage.classList.add(`status--${variant}`);
  }
}

function renderTable(rows) {
  tableBody.innerHTML = '';

  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.textContent = 'No blocked destinations in the current window.';
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }

  rows.forEach(({ name, count }) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const countCell = document.createElement('td');

    nameCell.textContent = name;
    countCell.textContent = count.toLocaleString();

    row.appendChild(nameCell);
    row.appendChild(countCell);
    tableBody.appendChild(row);
  });
}

function renderChart(totals) {
  const chartConstructor = window.Chart;
  if (typeof chartConstructor !== 'function') {
    console.warn('Chart.js unavailable; skipping chart render.');
    return;
  }

  const blocked = totals?.blocked ?? 0;
  const allowed = totals?.allowed ?? 0;

  const data = {
    labels: ['Blocked', 'Allowed'],
    datasets: [
      {
        label: 'Requests',
        data: [blocked, allowed],
        backgroundColor: ['#f87171', '#34d399'],
        borderWidth: 0,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: true,
    aspectRatio: 1.6,
    plugins: {
      legend: {
        position: 'bottom',
      },
    },
  };

  if (chartInstance) {
    chartInstance.data = data;
    chartInstance.update();
    return;
  }

  chartInstance = new chartConstructor(chartContext, {
    type: 'doughnut',
    data,
    options,
  });
}

function prepareLoadingState(rangeKey, options = {}) {
  const { forced } = options;
  const loadingLabel = rangeLabels[rangeKey] || rangeKey;

  setStatus(
    forced
      ? `Refreshing ${loadingLabel}…`
      : `Loading new ${
          cacheStatus.lastLoadedRange === rangeKey ? 'updates' : 'data'
        } for ${loadingLabel}…`,
    'loading'
  );
  refreshButton.disabled = true;
  if (rangeSelect) {
    rangeSelect.disabled = true;
  }
}

function finalizeLoadingState(controller) {
  if (currentFetchController === controller) {
    currentFetchController = null;
    refreshButton.disabled = false;
    if (rangeSelect) {
      rangeSelect.disabled = false;
    }
  }
}

async function loadSummary(requestedRange, options = {}) {
  const { forceRefresh = false, triggeredByUser = false } = options;
  const rangeToUse = requestedRange || rangeSelect?.value || currentRange || '7d';
  const loadingLabel = rangeLabels[rangeToUse] || rangeToUse;
  const sameRangeInFlight = inFlightRange === rangeToUse && currentFetchController;

  if (sameRangeInFlight && !forceRefresh) {
    console.info('Already loading this range; ignoring duplicate request.');
    return;
  }

  if (currentFetchController) {
    currentFetchController.abort();
    currentFetchController = null;
    inFlightRange = null;
  }

  currentRange = rangeToUse;

  const controller = new AbortController();
  currentFetchController = controller;
  inFlightRange = rangeToUse;

  prepareLoadingState(rangeToUse, { forced: forceRefresh });

  try {
    // Prefer a pre-generated static summary file (keeps function invocations to zero when available)
    let payload = null;
    if (!forceRefresh) {
      try {
        const staticResp = await fetch('./activity-summary.json', { cache: 'no-store' });
        if (staticResp.ok) {
          payload = await staticResp.json();
          // Mark as from static file
          payload.meta = payload.meta || {};
          payload.meta.fromCache = true;
        }
      } catch (e) {
        // ignore static load errors and fall back to API
      }
    }

    if (!payload) {
      const params = new URLSearchParams({ range: rangeToUse });
      if (forceRefresh) {
        params.set('force', '1');
      }
      const response = await fetch(`/api/activity-summary?${params.toString()}`, {
        signal: controller.signal,
      });
      payload = await response.json();

      if (!response.ok || payload?.error) {
        throw new Error(payload?.error || `Request failed with status ${response.status}`);
      }
    }

    // Choose rows based on view mode
    let tableRows = [];
    if (viewMode === 'blocked') {
      // Prefer a normalized/aggregated topBlocked (added by CI script). Fall back to legacy topBlocked.
      tableRows = payload.topBlockedNormalized ?? payload.topBlocked ?? [];

      // If the aggregated list is tiny (1 or 0 entries), try blockedSamples; if still tiny, fall back to topQueries
      if ((!Array.isArray(tableRows) || tableRows.length <= 1) && Array.isArray(payload.blockedSamples) && payload.blockedSamples.length) {
      const counts = {};
      payload.blockedSamples.forEach((s) => {
        const d = s.domain || 'unknown';
        counts[d] = (counts[d] || 0) + 1;
      });
      const derived = Object.entries(counts).map(([name, count]) => ({ name, count }));
      derived.sort((a, b) => b.count - a.count);

      // Merge aggregated tableRows (if any) with derived samples, summing counts for same names
      const mergedMap = new Map();
      (Array.isArray(tableRows) ? tableRows : []).forEach((r) => mergedMap.set(r.name, (mergedMap.get(r.name) || 0) + (r.count || 0)));
      derived.forEach((r) => mergedMap.set(r.name, (mergedMap.get(r.name) || 0) + (r.count || 0)));

      const merged = Array.from(mergedMap.entries()).map(([name, count]) => ({ name, count }));
      merged.sort((a, b) => b.count - a.count);
      tableRows = merged.slice(0, 10);
    }

      // If we still have very few rows, fall back to topQueries (most frequent overall destinaton)
      if ((!Array.isArray(tableRows) || tableRows.length <= 1) && Array.isArray(payload.topQueries) && payload.topQueries.length) {
        tableRows = payload.topQueries.slice(0, 10);
      }
    } else {
      // allowed view: show topQueries (non-deduped counts)
      tableRows = Array.isArray(payload.topQueries) ? payload.topQueries.slice(0, 10) : [];
    }

    renderTable(tableRows);
    try {
      // In blocked view, show blocked/allowed chart; in allowed view, show overall trend if available
      renderChart(payload.totals ?? {});
    } catch (chartError) {
      console.warn('Unable to render chart:', chartError);
    }

  const meta = payload?.meta || {};
    if (Object.keys(meta).length) {
      console.groupCollapsed('Cloudflare fetch details');
      console.log('Range requested:', rangeToUse, rangeLabels[rangeToUse] || '');
      console.log('Meta summary:', meta);
      if (Array.isArray(meta.messages) && meta.messages.length) {
        meta.messages.forEach((message, index) => {
          console.log(`Segment ${index + 1}: ${message}`);
        });
      }
      console.groupEnd();
      cacheStatus = {
        lastLoadedRange: rangeToUse,
        lastFetchedAt: meta.fetchedAt || null,
        isFromCache: Boolean(meta.fromCache),
      };
    }
    setStatus(
      `Load ${
        meta?.fromCache ? 'served from cache' : 'successful'
      } at ${new Date().toLocaleTimeString()}.`,
      'success'
    );

    if (rangeSelect) {
      rangeSelect.disabled = false;
      rangeSelect.value = payload?.requestedRange || rangeToUse;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.info('Activity summary request aborted.');
      return;
    }
    console.error('Failed to load activity summary:', error);
    // Try to fall back to the static summary file if available
    try {
      const staticResp = await fetch('./activity-summary.json', { cache: 'no-store' });
      if (staticResp.ok) {
        const staticPayload = await staticResp.json();
        const staticRows = staticPayload.topBlockedNormalized ?? staticPayload.topBlocked ?? [];
        if ((!staticRows || staticRows.length === 0) && Array.isArray(staticPayload.blockedSamples) && staticPayload.blockedSamples.length) {
          const counts = {};
          staticPayload.blockedSamples.forEach((s) => {
            const d = s.domain || 'unknown';
            counts[d] = (counts[d] || 0) + 1;
          });
          const derived = Object.entries(counts).map(([name, count]) => ({ name, count }));
          derived.sort((a, b) => b.count - a.count);
          renderTable(derived.slice(0, 10));
        } else {
          renderTable(staticRows);
        }
        try {
          renderChart(staticPayload.totals ?? {});
        } catch (chartError) {
          console.warn('Unable to render fallback chart:', chartError);
        }
        setStatus('Unable to fetch live data; showing last known summary.', 'error');
        return;
      }
    } catch (staticErr) {
      // ignore and continue to show empty fallback
      console.warn('Static fallback unavailable or invalid:', staticErr);
    }

    renderTable([]);
    try {
      renderChart({ blocked: 0, allowed: 0 });
    } catch (chartError) {
      console.warn('Unable to render fallback chart:', chartError);
    }
    const failureMessage = error?.message ? ` (${error.message})` : '';
    setStatus(`Unable to load data right now${failureMessage}. Showing fallback results.`, 'error');
    if (rangeSelect) {
      rangeSelect.value = currentRange;
    }
  } finally {
    finalizeLoadingState(controller);
    if (inFlightRange === rangeToUse) {
      inFlightRange = null;
    }
  }
}

refreshButton.addEventListener('click', () =>
  loadSummary(rangeSelect?.value || currentRange, { forceRefresh: true, triggeredByUser: true })
);

if (rangeSelect) {
  rangeSelect.addEventListener('change', () => loadSummary(rangeSelect.value, { triggeredByUser: true }));
}

document.addEventListener('DOMContentLoaded', () => loadSummary(currentRange));
