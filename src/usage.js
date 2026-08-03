import { localizePage, t } from "./i18n.js";

const FIELDS = ["inputTokens", "outputTokens", "inputAudioTokens", "outputAudioTokens", "cachedTokens"];
const MAX_BARS = 90;

let locale = "en";
let buckets = new Map();
let view = { rangeMinutes: 1440, bucketMinutes: 60, series: "all" };
let columns = [];

function formatTokens(value) {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(2)}M`;
  if (rounded >= 1000) return `${(rounded / 1000).toFixed(1)}k`;
  return String(rounded);
}

function readBucket(values = []) {
  const audio = (Number(values[2]) || 0) + (Number(values[3]) || 0);
  const all = (Number(values[0]) || 0) + (Number(values[1]) || 0);
  return { audio, text: Math.max(0, all - audio), all };
}

// The stored resolution is one minute; every coarser scale is folded from it here
// so the same data answers "per minute", "per hour" and "per day".
function aggregate() {
  const now = Math.floor(Date.now() / 60000);
  const minutes = [...buckets.keys()];
  if (!minutes.length) return [];
  const oldest = view.rangeMinutes ? now - view.rangeMinutes : Math.min(...minutes);
  const size = view.bucketMinutes;
  const grouped = new Map();

  for (const [minute, values] of buckets) {
    if (minute < oldest) continue;
    const slot = Math.floor(minute / size) * size;
    const split = readBucket(values);
    const current = grouped.get(slot) || { audio: 0, text: 0, all: 0 };
    grouped.set(slot, { audio: current.audio + split.audio, text: current.text + split.text, all: current.all + split.all });
  }
  if (!grouped.size) return [];

  // Empty slots are real information — they show when nothing was translated —
  // so the range is filled in rather than only plotting slots that have data.
  const first = Math.min(...grouped.keys());
  const last = Math.max(Math.max(...grouped.keys()), Math.floor(now / size) * size);
  const slots = [];
  for (let slot = first; slot <= last; slot += size) slots.push(slot);
  const trimmed = slots.slice(-MAX_BARS);
  return trimmed.map((slot) => ({ slot, ...(grouped.get(slot) || { audio: 0, text: 0, all: 0 }) }));
}

function seriesValue(item) {
  if (view.series === "audio") return item.audio;
  if (view.series === "text") return item.text;
  return item.all;
}

function slotLabel(slot) {
  const date = new Date(slot * 60000);
  if (view.bucketMinutes >= 1440) return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
  if (view.bucketMinutes >= 60) return date.toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit" });
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function renderChart() {
  const chart = document.querySelector("#usage-chart");
  const scale = document.querySelector("#usage-scale");
  const axis = document.querySelector("#usage-axis");
  const empty = document.querySelector("#usage-empty");

  const peak = Math.max(...columns.map(seriesValue), 1);
  empty.hidden = columns.length > 0;

  scale.replaceChildren(...[1, 0.75, 0.5, 0.25, 0].map((fraction) => {
    const mark = document.createElement("span");
    mark.textContent = fraction ? formatTokens(peak * fraction) : "0";
    return mark;
  }));

  chart.replaceChildren(...columns.map((item, index) => {
    const column = document.createElement("div");
    column.className = "usage-column";
    column.dataset.index = String(index);
    column.tabIndex = 0;
    column.setAttribute("role", "listitem");
    column.setAttribute("aria-label", `${slotLabel(item.slot)}: ${formatTokens(seriesValue(item))}`);

    const bar = document.createElement("div");
    bar.className = "usage-bar";
    bar.style.height = `${seriesValue(item) ? Math.max(2, (seriesValue(item) / peak) * 100) : 0}%`;
    if (view.series === "all") {
      const text = document.createElement("span");
      text.className = "usage-bar-text";
      const audio = document.createElement("span");
      audio.className = "usage-bar-audio";
      audio.style.height = item.all ? `${(item.audio / item.all) * 100}%` : "0%";
      bar.append(text, audio);
    } else {
      const only = document.createElement("span");
      only.className = view.series === "audio" ? "usage-bar-audio" : "usage-bar-text";
      only.style.height = "100%";
      bar.append(only);
    }
    column.append(bar);
    return column;
  }));

  axis.replaceChildren(...(columns.length ? [columns[0], columns[columns.length - 1]] : []).map((item) => {
    const span = document.createElement("span");
    span.textContent = slotLabel(item.slot);
    return span;
  }));
}

function showTooltip(index, anchor, segment = null) {
  const item = columns[index];
  const tooltip = document.querySelector("#usage-tooltip");
  if (!item) return;
  tooltip.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = slotLabel(item.slot);
  const rows = [
    ["all", t(locale, "totalTokens"), item.all],
    ["audio", t(locale, "audioTokens"), item.audio],
    ["text", t(locale, "textTokens"), item.text]
  ].filter(([key]) => view.series === "all" || key === view.series || key === "all");

  tooltip.append(title, ...rows.map(([key, label, value]) => {
    const row = document.createElement("span");
    // The row for the colour under the pointer is highlighted, so hovering a
    // segment answers "how much of this bar is audio" without hunting for it.
    row.className = `usage-tip-row usage-tip-${key}${segment === key ? " is-active" : ""}`;
    const share = item.all && key !== "all" ? ` · ${Math.round((value / item.all) * 100)}%` : "";
    row.textContent = `${label}: ${formatTokens(value)}${share}`;
    return row;
  }));

  // Anchored to the hovered column, then clamped so it never leaves the plot.
  const plot = document.querySelector("#usage-plot");
  const plotBox = plot.getBoundingClientRect();
  const barBox = anchor.getBoundingClientRect();
  tooltip.hidden = false;
  const width = tooltip.offsetWidth;
  const left = barBox.left - plotBox.left + barBox.width / 2 - width / 2;
  tooltip.style.left = `${Math.max(0, Math.min(left, plotBox.width - width))}px`;
  tooltip.style.top = `${Math.max(0, barBox.top - plotBox.top - tooltip.offsetHeight - 8)}px`;
}

function hideTooltip() {
  document.querySelector("#usage-tooltip").hidden = true;
}

function renderTotals() {
  const totals = columns.reduce((sum, item) => ({
    audio: sum.audio + item.audio,
    text: sum.text + item.text,
    all: sum.all + item.all
  }), { audio: 0, text: 0, all: 0 });
  const share = (value) => (totals.all ? `${Math.round((value / totals.all) * 100)}%` : "—");
  const active = columns.filter((item) => item.all > 0).length;

  document.querySelector("#total-tokens").textContent = formatTokens(totals.all);
  document.querySelector("#total-window").textContent = columns.length ? t(locale, "acrossSlots", { count: active }) : "";
  document.querySelector("#audio-tokens").textContent = formatTokens(totals.audio);
  document.querySelector("#audio-share").textContent = share(totals.audio);
  document.querySelector("#text-tokens").textContent = formatTokens(totals.text);
  document.querySelector("#text-share").textContent = share(totals.text);
  document.querySelector("#recent-tokens").textContent = formatTokens(active ? totals.all / active : 0);
  document.querySelector("#recent-average").textContent = t(locale, `avgPer${view.bucketMinutes >= 1440 ? "Day" : view.bucketMinutes >= 60 ? "Hour" : "Minute"}`);
}

function draw() {
  columns = aggregate();
  renderChart();
  renderTotals();
  hideTooltip();
  // Keeps the legend in step no matter which control changed the series.
  document.querySelectorAll(".usage-legend-item").forEach((entry) => {
    entry.classList.toggle("selected", view.series !== "all" && entry.dataset.series === view.series);
  });
}

function wireGroup(id, apply) {
  document.querySelector(id).addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    [...button.parentElement.children].forEach((item) => item.classList.toggle("active", item === button));
    apply(button.dataset);
    draw();
  });
}

async function load() {
  const stored = await chrome.storage.local.get({ usageBuckets: {}, usageDaily: {}, interfaceLanguage: "en", sessionCount: 0 });
  locale = stored.interfaceLanguage || "en";
  localizePage(locale);
  document.title = `${t(locale, "tokenUsage")} — ${t(locale, "appTitle")}`;

  buckets = new Map(Object.entries(stored.usageBuckets).map(([minute, values]) => [Number(minute), values]));
  // Usage recorded before per-minute buckets existed is kept, parked at midday of
  // its day so it still shows up on the daily scale.
  for (const [day, values] of Object.entries(stored.usageDaily || {})) {
    const minute = Math.floor(new Date(`${day}T12:00:00`).getTime() / 60000);
    if (!Number.isFinite(minute) || buckets.has(minute)) continue;
    buckets.set(minute, FIELDS.map((key) => Number(values[key]) || 0));
  }

  const empty = document.querySelector("#usage-empty");
  empty.textContent = t(locale, buckets.size === 0 && stored.sessionCount > 0 ? "usageNotReported" : "noUsageYet");
  draw();
}

wireGroup("#range-group", (data) => { view.rangeMinutes = Number(data.range); });
wireGroup("#scale-group", (data) => { view.bucketMinutes = Number(data.bucket); });
wireGroup("#series-group", (data) => { view.series = data.series; });

const chart = document.querySelector("#usage-chart");

function segmentUnder(target) {
  if (target.closest(".usage-bar-audio")) return "audio";
  if (target.closest(".usage-bar-text")) return "text";
  return null;
}

for (const event of ["mouseover", "mousemove", "focusin"]) {
  chart.addEventListener(event, (domEvent) => {
    const column = domEvent.target.closest(".usage-column");
    if (!column) return;
    const segment = event === "focusin" ? null : segmentUnder(domEvent.target);
    chart.dataset.hovered = segment || "";
    showTooltip(Number(column.dataset.index), column, segment);
  });
}
chart.addEventListener("mouseleave", () => {
  chart.dataset.hovered = "";
  hideTooltip();
});
chart.addEventListener("focusout", hideTooltip);

// Hovering a legend colour previews that series on its own; clicking commits to it,
// which is what the Series buttons do. Preview is purely visual so the scale does
// not jump around while the pointer moves across the labels.
const legend = document.querySelector("#usage-legend");
const plot = document.querySelector("#usage-plot");
function previewSeries(series) {
  plot.classList.toggle("preview-audio", series === "audio");
  plot.classList.toggle("preview-text", series === "text");
}
for (const [event, series] of [["mouseover", null], ["focusin", null]]) {
  legend.addEventListener(event, (domEvent) => {
    const item = domEvent.target.closest(".usage-legend-item");
    previewSeries(item ? item.dataset.series : series);
  });
}
legend.addEventListener("mouseleave", () => previewSeries(null));
legend.addEventListener("focusout", () => previewSeries(null));
legend.addEventListener("click", (domEvent) => {
  const item = domEvent.target.closest(".usage-legend-item");
  if (!item) return;
  // Clicking the active series returns to showing both.
  const next = view.series === item.dataset.series ? "all" : item.dataset.series;
  view.series = next;
  previewSeries(null);
  document.querySelectorAll("#series-group button").forEach((button) => {
    button.classList.toggle("active", button.dataset.series === next);
  });
  draw();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.usageBuckets || changes.usageDaily)) load();
});

load();
