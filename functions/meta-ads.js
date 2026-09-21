// functions/meta-ads.js
//
// Netlify Function (Node 18+, sin dependencias npm — usa el fetch global).
// Llama a la REST API de Windsor.ai (conector "facebook" = Meta Ads) y
// devuelve JSON ya procesado para el dashboard de IMPULSE.
//
// Variables de entorno requeridas en Netlify:
//   WINDSOR_API_KEY  (marcar "Contains secret values" = NO / envVarIsSecret:false)
//
// Notas importantes (lecciones aprendidas, no las repitas):
//   - Windsor NO tiene date_preset "last_month". Los rangos de mes se
//     construyen a mano con date_from/date_to.
//   - El filtro de cuenta es "select_accounts", NO "account_id".
//     account_id es solo un campo de datos.
//   - Todas las llamadas a Windsor usan AbortController con timeout.
//   - Esta cuenta (IMPULSE NUTRITION) es de generación de leads, no
//     ecommerce: no hay compras/carritos/checkouts vía píxel. El embudo
//     real es Clics -> Visitas web (landing page view) -> Leads
//     (formulario de sesión diagnóstica = "complete_registration").
//     KPIs de facturación/ROAS/AOV se sustituyen por Leads/CPL/Tasa de
//     conversión (ver README / conversación con David).

'use strict';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

const WINDSOR_BASE_URL = 'https://connectors.windsor.ai/facebook';
const ACCOUNT_ID = '4007753822702358'; // IMPULSE NUTRITION (Meta Ads)
const FETCH_TIMEOUT_MS = 9000;

// Umbrales para evitar ruido estadístico
const MIN_SPEND_INSIGHTS = 15; // € mínimos de inversión para entrar en el motor escalar/pausar
const SCALE_CPL_RATIO = 0.6; // CPL <= 60% del CPL medio de la cuenta -> escalar (40%+ más barato)
const PAUSE_CPL_RATIO = 1.5; // CPL >= 150% del CPL medio de la cuenta -> pausar (50%+ más caro)

const MIN_SPEND_RANKING = 10; // € mínimos de inversión para entrar en un ranking
const MIN_LEADS_RANKING = 1; // leads mínimos para entrar en rankings de eficiencia (CPL, conversión)

const AD_LEVEL_FIELDS = [
  'campaign',
  'campaign_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'thumbnail_url',
  'image_url',
  'spend',
  'clicks',
  'impressions',
  'frequency',
  'actions_link_click',
  'actions_landing_page_view',
  'actions_complete_registration',
];

const ACCOUNT_TOTALS_FIELDS = [
  'spend',
  'clicks',
  'impressions',
  'actions_link_click',
  'actions_landing_page_view',
  'actions_complete_registration',
];

const TREND_FIELDS = [
  'date',
  'spend',
  'clicks',
  'actions_link_click',
  'actions_landing_page_view',
  'actions_complete_registration',
];

const MONTH_LABELS_ES = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

// ---------------------------------------------------------------------
// Helpers de fechas (UTC, sin librerías)
// ---------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function fmtDateLabel(d) {
  return `${pad2(d.getUTCDate())} ${MONTH_LABELS_ES[d.getUTCMonth()]}`;
}

function daysInMonth(year, monthIndex /* 0-based */) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function firstDayOfMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1));
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

// Devuelve los 4 rangos de fecha que necesita el dashboard, a partir de
// la fecha actual (UTC). Todo se calcula a mano porque Windsor no tiene
// un preset fiable para "mes anterior completo".
function computePeriods(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed

  // --- "Mes en curso": del día 1 del mes actual a hoy ---
  const curStart = firstDayOfMonth(y, m);
  const curEnd = now;

  // Comparación: mismos días del mes inmediatamente anterior
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 11 : m - 1;
  const compDay = Math.min(now.getUTCDate(), daysInMonth(prevY, prevM));
  const curCompStart = firstDayOfMonth(prevY, prevM);
  const curCompEnd = new Date(Date.UTC(prevY, prevM, compDay));

  // --- "Mes anterior completo" ---
  const lastFullStart = firstDayOfMonth(prevY, prevM);
  const lastFullEnd = lastDayOfMonth(prevY, prevM);

  // Comparación: el mes completo anterior a ese
  const prev2Y = prevM === 0 ? prevY - 1 : prevY;
  const prev2M = prevM === 0 ? 11 : prevM - 1;
  const lastFullCompStart = firstDayOfMonth(prev2Y, prev2M);
  const lastFullCompEnd = lastDayOfMonth(prev2Y, prev2M);

  // --- Tendencia: 3 meses (2 completos + el actual, provisional) ---
  const trendY = prev2Y;
  const trendM = prev2M;
  const trendStart = firstDayOfMonth(trendY, trendM);
  const trendEnd = now;

  return {
    current: {
      key: 'current',
      label: 'Mes en curso',
      start: curStart,
      end: curEnd,
      comparisonStart: curCompStart,
      comparisonEnd: curCompEnd,
    },
    lastFull: {
      key: 'lastFull',
      label: 'Mes anterior completo',
      start: lastFullStart,
      end: lastFullEnd,
      comparisonStart: lastFullCompStart,
      comparisonEnd: lastFullCompEnd,
    },
    trend: {
      start: trendStart,
      end: trendEnd,
    },
    currentMonthKey: `${y}-${pad2(m + 1)}`,
  };
}

// ---------------------------------------------------------------------
// Cliente Windsor
// ---------------------------------------------------------------------

async function fetchWindsor(fields, dateFrom, dateTo) {
  const params = new URLSearchParams();
  params.set('api_key', process.env.WINDSOR_API_KEY || '');
  params.set('select_accounts', ACCOUNT_ID);
  params.set('date_from', fmtDate(dateFrom));
  params.set('date_to', fmtDate(dateTo));
  params.set('fields', fields.join(','));

  const url = `${WINDSOR_BASE_URL}?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Windsor respondió ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    const json = await res.json();
    // La API de Windsor devuelve { data: [...] }. Somos defensivos por si
    // cambia la forma de la respuesta.
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json.result)) return json.result;
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Utilidades numéricas
// ---------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeDiv(a, b) {
  return b > 0 ? a / b : 0;
}

function round(v, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round((v + Number.EPSILON) * f) / f;
}

function pctChange(current, previous) {
  if (previous === 0) {
    return current === 0 ? 0 : null; // null = "no comparable" (de 0 a algo)
  }
  return ((current - previous) / previous) * 100;
}

// ---------------------------------------------------------------------
// Agregaciones
// ---------------------------------------------------------------------

function emptyTotals() {
  return { spend: 0, clicks: 0, impressions: 0, linkClicks: 0, landingPageViews: 0, leads: 0, frequencySum: 0, frequencyWeight: 0 };
}

function addRowToTotals(totals, row) {
  totals.spend += num(row.spend);
  totals.clicks += num(row.clicks);
  totals.impressions += num(row.impressions);
  totals.linkClicks += num(row.actions_link_click);
  totals.landingPageViews += num(row.actions_landing_page_view);
  totals.leads += num(row.actions_complete_registration);
  if (row.frequency != null && num(row.impressions) > 0) {
    totals.frequencySum += num(row.frequency) * num(row.impressions);
    totals.frequencyWeight += num(row.impressions);
  }
}

function totalsFromRows(rows) {
  const totals = emptyTotals();
  rows.forEach((row) => addRowToTotals(totals, row));
  return totals;
}

function deriveMetrics(totals) {
  const cpl = safeDiv(totals.spend, totals.leads);
  const ctr = safeDiv(totals.clicks, totals.impressions);
  const cpc = safeDiv(totals.spend, totals.clicks);
  const cpm = safeDiv(totals.spend, totals.impressions) * 1000;
  const lpvRate = safeDiv(totals.landingPageViews, totals.linkClicks || totals.clicks);
  const leadRate = safeDiv(totals.leads, totals.landingPageViews);
  const frequency = safeDiv(totals.frequencySum, totals.frequencyWeight);
  return {
    spend: round(totals.spend),
    clicks: totals.clicks,
    impressions: totals.impressions,
    linkClicks: totals.linkClicks,
    landingPageViews: totals.landingPageViews,
    leads: totals.leads,
    cpl: round(cpl),
    ctr: round(ctr * 100, 2),
    cpc: round(cpc),
    cpm: round(cpm),
    lpvRate: round(lpvRate * 100, 2),
    leadRate: round(leadRate * 100, 2),
    frequency: round(frequency, 2),
  };
}

function kpiBlock(currentValue, previousValue, opts = {}) {
  const { lowerIsBetter = false } = opts;
  const deltaPct = pctChange(currentValue, previousValue);
  let trend = 'flat';
  let good = null;
  if (deltaPct !== null && Math.abs(deltaPct) >= 0.5) {
    trend = deltaPct > 0 ? 'up' : 'down';
    const improved = lowerIsBetter ? deltaPct < 0 : deltaPct > 0;
    good = improved;
  } else if (deltaPct !== null) {
    good = null; // neutral, variación insignificante
  }
  return {
    value: currentValue,
    previousValue,
    deltaPct: deltaPct === null ? null : round(deltaPct, 1),
    trend,
    good,
  };
}

// ---------------------------------------------------------------------
// Embudo + diagnóstico de cuello de botella
// ---------------------------------------------------------------------

function buildFunnel(totals) {
  const linkClicks = totals.linkClicks || totals.clicks;
  const lpv = totals.landingPageViews;
  const leads = totals.leads;
  const frequency = round(safeDiv(totals.frequencySum, totals.frequencyWeight), 2);

  const steps = [
    {
      key: 'clicks',
      name: 'Clics',
      value: linkClicks,
      cost: round(safeDiv(totals.spend, linkClicks)),
      convPct: null, // primer paso, no tiene conversión previa
    },
    {
      key: 'landing',
      name: 'Visitas web',
      value: lpv,
      cost: round(safeDiv(totals.spend, lpv)),
      convPct: round(safeDiv(lpv, linkClicks) * 100, 1),
    },
    {
      key: 'leads',
      name: 'Leads',
      value: leads,
      cost: round(safeDiv(totals.spend, leads)),
      convPct: round(safeDiv(leads, lpv) * 100, 1),
    },
  ];

  // Diagnóstico del cuello de botella: comparamos cada tasa de conversión
  // contra un benchmark razonable para un embudo de leads de Meta Ads.
  const benchmarks = {
    landing: { min: 85, label: 'clic → visita web' }, // si el link funciona bien, casi todo clic debería cargar la página
    leads: { min: 10, label: 'visita web → lead' }, // conversión típica de una landing de captación bien optimizada
  };

  let bottleneck = null;
  let worstGapPct = -Infinity;
  ['landing', 'leads'].forEach((key) => {
    const step = steps.find((s) => s.key === key);
    const benchmark = benchmarks[key];
    if (step.convPct === null || Number.isNaN(step.convPct)) return;
    const gap = benchmark.min - step.convPct; // positivo = por debajo del benchmark
    if (gap > worstGapPct) {
      worstGapPct = gap;
      bottleneck = {
        step: step.name,
        stepKey: key,
        convPct: step.convPct,
        benchmarkPct: benchmark.min,
        label: benchmark.label,
        isBottleneck: gap > 0,
      };
    }
  });

  return { steps, frequency, bottleneck };
}

// ---------------------------------------------------------------------
// Motor de Escalar / Revisar-pausar
// ---------------------------------------------------------------------

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function buildScalePauseList(rows, keyFn, accountCpl) {
  const grouped = groupBy(rows, keyFn);
  const list = [];
  grouped.forEach((groupRows, name) => {
    const totals = totalsFromRows(groupRows);
    if (totals.spend < MIN_SPEND_INSIGHTS) return; // ruido estadístico
    const metrics = deriveMetrics(totals);
    let action = 'watch';
    let reason = '';
    if (totals.leads === 0) {
      action = 'pause';
      reason = `${round(totals.spend)} € invertidos sin ningún lead`;
    } else if (metrics.cpl >= accountCpl * PAUSE_CPL_RATIO) {
      action = 'pause';
      const pctMoreExpensive = round((metrics.cpl / accountCpl - 1) * 100, 0);
      reason = `CPL ${pctMoreExpensive}% más caro que la media de la cuenta`;
    } else if (metrics.cpl <= accountCpl * SCALE_CPL_RATIO) {
      action = 'scale';
      const pctCheaper = round((1 - metrics.cpl / accountCpl) * 100, 0);
      reason = `CPL ${pctCheaper}% más barato que la media de la cuenta`;
    } else {
      reason = 'Dentro de rango, sin señal clara';
    }
    list.push({
      name,
      spend: metrics.spend,
      leads: metrics.leads,
      cpl: metrics.cpl,
      ctr: metrics.ctr,
      action,
      reason,
    });
  });
  // Escalar primero (mejor CPL), luego watch, luego pause (peor CPL primero dentro de cada grupo)
  const order = { scale: 0, watch: 1, pause: 2 };
  list.sort((a, b) => {
    if (order[a.action] !== order[b.action]) return order[a.action] - order[b.action];
    return a.cpl - b.cpl;
  });
  return list;
}

// ---------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------

function buildRankings(rows) {
  const grouped = groupBy(rows, (r) => r.adset_name || '(sin audiencia)');
  const entries = [];
  grouped.forEach((groupRows, name) => {
    const totals = totalsFromRows(groupRows);
    const metrics = deriveMetrics(totals);
    entries.push({ name, ...metrics, campaign: groupRows[0].campaign || '' });
  });

  const eligible = entries.filter((e) => e.spend >= MIN_SPEND_RANKING && e.leads >= MIN_LEADS_RANKING);

  const bestCpl = [...eligible].sort((a, b) => a.cpl - b.cpl).slice(0, 5)
    .map((e) => ({ name: e.name, campaign: e.campaign, value: e.cpl, spend: e.spend, leads: e.leads }));

  const bestConversion = [...eligible].sort((a, b) => b.leadRate - a.leadRate).slice(0, 5)
    .map((e) => ({ name: e.name, campaign: e.campaign, value: e.leadRate, spend: e.spend, leads: e.leads }));

  const bestCtr = [...entries.filter((e) => e.spend >= MIN_SPEND_RANKING)]
    .sort((a, b) => b.ctr - a.ctr).slice(0, 5)
    .map((e) => ({ name: e.name, campaign: e.campaign, value: e.ctr, spend: e.spend, leads: e.leads }));

  return { bestCpl, bestConversion, bestCtr };
}

// ---------------------------------------------------------------------
// Creatividades
// ---------------------------------------------------------------------

function buildCreatives(rows) {
  const grouped = groupBy(rows, (r) => r.ad_id);
  const creatives = [];
  grouped.forEach((groupRows, adId) => {
    const totals = totalsFromRows(groupRows);
    const metrics = deriveMetrics(totals);
    const first = groupRows[0];
    creatives.push({
      adId,
      name: first.ad_name || '(sin nombre)',
      campaign: first.campaign || '',
      audience: first.adset_name || '',
      image: first.thumbnail_url || first.image_url || null,
      ...metrics,
    });
  });

  const withSpend = creatives.filter((c) => c.spend > 0);
  // Orden: más leads primero; empate -> menor CPL; empate -> más inversión
  const sorted = [...withSpend].sort((a, b) => {
    if (b.leads !== a.leads) return b.leads - a.leads;
    if (a.cpl !== b.cpl) return (a.cpl || Infinity) - (b.cpl || Infinity);
    return b.spend - a.spend;
  });

  return {
    top4: sorted.slice(0, 4),
    top10: sorted.slice(0, 10),
    all: sorted,
  };
}

// ---------------------------------------------------------------------
// Tendencia (últimos 3 meses)
// ---------------------------------------------------------------------

function buildTrend(rows, currentMonthKey) {
  const byMonth = new Map();
  rows.forEach((row) => {
    const date = row.date;
    if (!date) return;
    const monthKey = String(date).slice(0, 7); // "YYYY-MM"
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(row);
  });

  const months = [...byMonth.keys()].sort().map((monthKey) => {
    const totals = totalsFromRows(byMonth.get(monthKey));
    const metrics = deriveMetrics(totals);
    const [y, m] = monthKey.split('-').map(Number);
    return {
      monthKey,
      label: MONTH_LABELS_ES[m - 1],
      year: y,
      provisional: monthKey === currentMonthKey,
      cpc: metrics.cpc,
      cpl: metrics.cpl,
      leadRate: metrics.leadRate,
      spend: metrics.spend,
      leads: metrics.leads,
    };
  });

  // Solo los últimos 3 meses con datos
  return months.slice(-3);
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------

exports.handler = async (event) => {
  try {
    if (!process.env.WINDSOR_API_KEY) {
      return jsonResponse(500, { error: 'Falta la variable de entorno WINDSOR_API_KEY en Netlify.' });
    }

    const qs = (event && event.queryStringParameters) || {};
    const periodKey = qs.period === 'lastFull' ? 'lastFull' : 'current';

    const now = new Date();
    const periods = computePeriods(now);
    const selected = periods[periodKey];

    const [primaryRows, comparisonRows, trendRows] = await Promise.all([
      fetchWindsor(AD_LEVEL_FIELDS, selected.start, selected.end),
      fetchWindsor(ACCOUNT_TOTALS_FIELDS, selected.comparisonStart, selected.comparisonEnd),
      fetchWindsor(TREND_FIELDS, periods.trend.start, periods.trend.end),
    ]);

    const primaryTotals = totalsFromRows(primaryRows);
    const primaryMetrics = deriveMetrics(primaryTotals);

    const comparisonTotals = totalsFromRows(comparisonRows);
    const comparisonMetrics = deriveMetrics(comparisonTotals);

    const kpis = {
      leads: kpiBlock(primaryMetrics.leads, comparisonMetrics.leads),
      spend: kpiBlock(primaryMetrics.spend, comparisonMetrics.spend), // ni "bueno" ni "malo" per se, se marca neutral abajo
      cpl: kpiBlock(primaryMetrics.cpl, comparisonMetrics.cpl, { lowerIsBetter: true }),
      leadRate: kpiBlock(primaryMetrics.leadRate, comparisonMetrics.leadRate),
    };
    // La inversión es informativa, no "buena" ni "mala" en sí misma -> siempre neutral
    kpis.spend.good = null;

    const funnel = buildFunnel(primaryTotals);

    const insights = {
      accountCpl: primaryMetrics.cpl,
      campaigns: buildScalePauseList(primaryRows, (r) => r.campaign || '(sin campaña)', primaryMetrics.cpl),
      audiences: buildScalePauseList(primaryRows, (r) => r.adset_name || '(sin audiencia)', primaryMetrics.cpl),
    };

    const rankings = buildRankings(primaryRows);
    const creatives = buildCreatives(primaryRows);
    const trend = buildTrend(trendRows, periods.currentMonthKey);

    const responseBody = {
      meta: {
        period: periodKey,
        periodLabel: selected.label,
        rangeLabel: `${fmtDateLabel(selected.start)} – ${fmtDateLabel(selected.end)}`,
        comparisonRangeLabel: `${fmtDateLabel(selected.comparisonStart)} – ${fmtDateLabel(selected.comparisonEnd)}`,
        generatedAt: now.toISOString(),
        account: 'IMPULSE NUTRITION',
      },
      kpis,
      funnel,
      trend,
      insights,
      rankings,
      creatives,
    };

    return jsonResponse(200, responseBody);
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    return jsonResponse(isAbort ? 504 : 500, {
      error: isAbort
        ? 'Windsor no respondió a tiempo (timeout de 9s). Inténtalo de nuevo.'
        : `Error generando el dashboard: ${err && err.message ? err.message : String(err)}`,
    });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

// Exportamos internals para poder testear con un fetch mockeado sin
// pasar por el handler HTTP completo.
exports._internal = {
  computePeriods,
  fetchWindsor,
  totalsFromRows,
  deriveMetrics,
  buildFunnel,
  buildScalePauseList,
  buildRankings,
  buildCreatives,
  buildTrend,
};
