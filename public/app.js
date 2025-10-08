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

    renderTable(payload.topBlocked ?? []);
    try {
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
