const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CONFIG_KEY = "railBookerConfig";
const STATE_KEY = "railBookerState";
const LOG_KEY = "railBookerLogs";

const fields = [
  "fromStation",
  "toStation",
  "journeyDate",
  "trainClass",
  "targetTrain",
  "preferredCoach",
  "seatQuantity",
  "preferredSeats",
  "boardingStation",
  "scheduleDate",
  "scheduleHour",
  "scheduleMinute",
  "scheduleSecond",
  "scheduleMs"
];

const $ = (id) => document.getElementById(id);

function pad(value, size) {
  return String(value ?? "").padStart(size, "0");
}

function todayISO() {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1, 2),
    pad(now.getDate(), 2)
  ].join("-");
}

function defaultConfig() {
  return {
    fromStation: "",
    toStation: "",
    journeyDate: "",
    trainClass: "SNIGDHA",
    targetTrain: "",
    preferredCoach: "",
    seatQuantity: 1,
    preferredSeats: "",
    boardingStation: "",
    allowCoachFallback: false,
    scheduleDate: todayISO(),
    scheduleHour: "08",
    scheduleMinute: "00",
    scheduleSecond: "00",
    scheduleMs: "000"
  };
}

function readForm() {
  const config = defaultConfig();
  for (const name of fields) {
    const el = $(name);
    if (name === "seatQuantity") config[name] = Number(el.value);
    else config[name] = el.value.trim();
  }
  config.allowCoachFallback = $("allowCoachFallback").checked;
  config.scheduleHour = pad(config.scheduleHour, 2);
  config.scheduleMinute = pad(config.scheduleMinute, 2);
  config.scheduleSecond = pad(config.scheduleSecond, 2);
  config.scheduleMs = pad(config.scheduleMs, 3);
  return config;
}

function writeForm(config) {
  const merged = { ...defaultConfig(), ...(config || {}) };
  for (const name of fields) {
    if (merged[name] !== undefined && merged[name] !== null) $(name).value = merged[name];
  }
  $("allowCoachFallback").checked = Boolean(merged.allowCoachFallback);
}

function formatDoj(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) return "";
  return `${match[3]}-${MONTHS[Number(match[2]) - 1]}-${match[1]}`;
}

function searchUrl(config) {
  const doj = formatDoj(config.journeyDate);
  if (!config.fromStation || !config.toStation || !doj || !config.trainClass) return "";
  const params = new URLSearchParams({
    fromcity: config.fromStation,
    tocity: config.toStation,
    doj,
    class: config.trainClass
  });
  return `https://eticket.railway.gov.bd/booking/train/search?${params.toString()}`;
}

function updatePreview() {
  const url = searchUrl(readForm());
  $("url-preview").textContent = url || "Search URL appears after station, date, and class are set.";
}

function showMessage(text, kind) {
  const el = $("form-message");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `form-message ${kind || ""}`;
}

function inRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validate(config, { requireSchedule }) {
  if (!config.fromStation || !config.toStation) return "From and To stations are required.";
  if (config.fromStation.toLowerCase() === config.toStation.toLowerCase()) {
    return "From and To must be different stations.";
  }
  if (!formatDoj(config.journeyDate)) return "Journey date is required.";
  if (!config.trainClass) return "Class is required.";
  if (!config.targetTrain) return "Target train is required.";
  if (!inRange(config.seatQuantity, 1, 4)) return "Seat quantity must be 1–4.";
  if (!requireSchedule) return "";
  const hour = Number(config.scheduleHour);
  const minute = Number(config.scheduleMinute);
  const second = Number(config.scheduleSecond);
  const ms = Number(config.scheduleMs);
  if (!inRange(hour, 0, 23) || !inRange(minute, 0, 59) || !inRange(second, 0, 59) || !inRange(ms, 0, 999)) {
    return "Trigger time must be HH 0–23, MM/SS 0–59, MS 0–999.";
  }
  if (!config.scheduleDate) return "Trigger date is required.";
  const target = computeTarget(config);
  if (!Number.isFinite(target)) return "Trigger time is invalid.";
  if (target <= Date.now()) return "Trigger time is already in the past.";
  return "";
}

function computeTarget(config) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(config.scheduleDate);
  if (!match) return NaN;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(config.scheduleHour),
    Number(config.scheduleMinute),
    Number(config.scheduleSecond),
    Number(config.scheduleMs)
  ).getTime();
}

async function saveConfig() {
  const config = readForm();
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
  return config;
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00:00.000";
  const hour = Math.floor(ms / 3600000);
  const minute = Math.floor((ms % 3600000) / 60000);
  const second = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(milli, 3)}`;
}

function renderStatus(state, logs) {
  const phase = state?.phase || "IDLE";
  const badge = $("phase-badge");
  badge.textContent = phase;
  badge.className = phase;
  const entries = Array.isArray(logs) ? logs : [];
  const last = entries[entries.length - 1];
  $("last-log").textContent = last ? `${new Date(last.t).toLocaleTimeString()} — ${last.message}` : "No log yet.";
  const list = $("log-list");
  list.replaceChildren();
  entries.slice(-12).reverse().forEach((entry) => {
    const li = document.createElement("li");
    li.className = entry.level || "";
    const time = new Date(entry.t).toLocaleTimeString();
    li.textContent = `${time}  ${entry.message}`;
    list.appendChild(li);
  });
  if (state?.driftMs !== undefined && state?.driftMs !== null && phase !== "ARMED" && phase !== "IDLE") {
    const sign = state.driftMs > 0 ? "+" : "";
    $("drift").textContent = `Fire drift: ${sign}${state.driftMs} ms`;
  } else if (state?.lastError && phase === "ERROR") {
    $("drift").textContent = state.lastError;
  } else {
    $("drift").textContent = "";
  }
  return phase;
}

let latestState = null;

function tickCountdown() {
  const phase = latestState?.phase;
  if (phase === "ARMED" && latestState.targetTimestamp) {
    $("countdown").textContent = formatCountdown(latestState.targetTimestamp - Date.now());
  } else if (phase === "STOPPED_AT_OTP") {
    $("countdown").textContent = "Stopped";
  } else if (phase === "ERROR") {
    $("countdown").textContent = "Stopped";
  } else {
    $("countdown").textContent = "—";
  }
}

function fillStationList() {
  const list = $("station-list");
  const names = Array.isArray(RAIL_STATIONS) ? RAIL_STATIONS : [];
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    list.appendChild(option);
  }
}

async function refresh() {
  const stored = await chrome.storage.local.get([STATE_KEY, LOG_KEY]);
  latestState = stored[STATE_KEY] || { phase: "IDLE" };
  renderStatus(latestState, stored[LOG_KEY]);
  tickCountdown();
}

document.addEventListener("DOMContentLoaded", async () => {
  fillStationList();
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  writeForm(stored[CONFIG_KEY]);
  if (!stored[CONFIG_KEY]?.scheduleDate) $("scheduleDate").value = todayISO();
  updatePreview();
  await refresh();

  $("config-form").addEventListener("input", () => {
    updatePreview();
    saveConfig();
  });
  $("config-form").addEventListener("change", () => {
    updatePreview();
    saveConfig();
  });

  $("save-btn").addEventListener("click", async () => {
    await saveConfig();
    showMessage("Config saved.", "ok");
  });

  $("arm-btn").addEventListener("click", async () => {
    const config = await saveConfig();
    const error = validate(config, { requireSchedule: true });
    if (error) {
      showMessage(error, "error");
      return;
    }
    const targetTimestamp = computeTarget(config);
    showMessage("Arming…", "ok");
    const response = await chrome.runtime.sendMessage({ type: "ARM", targetTimestamp });
    if (!response?.ok) {
      showMessage(response?.error || "Could not arm.", "error");
      return;
    }
    showMessage("Armed. Leave the railway tab open and stay logged in.", "ok");
    await refresh();
  });

  $("disarm-btn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "DISARM" });
    showMessage("Disarmed.", "ok");
    await refresh();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STATE_KEY] || changes[LOG_KEY]) refresh();
});

setInterval(tickCountdown, 50);
