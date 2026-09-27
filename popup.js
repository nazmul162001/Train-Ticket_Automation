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
  "scheduleDate",
  "scheduleHour",
  "scheduleMinute",
  "scheduleSecond",
  "scheduleMs",
  "schedulePeriod"
];

const COACHES = ["KA", "KHA", "GA", "GHA", "UMA", "CHA", "SCHA", "JA", "JHA", "NEO", "TA", "THA", "DA", "DHA", "DANT", "TO", "THO", "DOA", "XTR", "SLR"];
const SEAT_COUNT = 80;
const TRAINS = [
  ["SUBARNA EXPRESS", [701, 702]],
  ["MAHANAGAR GODHULI", [703]],
  ["MAHANAGAR PROVATI", [704]],
  ["EKOTA EXPRESS", [705, 706]],
  ["TISTA EXPRESS", [707, 708]],
  ["PARABAT EXPRESS", [709, 710]],
  ["UPAKUL EXPRESS", [711, 712]],
  ["KARATOYA EXPRESS", [713, 714]],
  ["KAPOTAKSHA EXPRESS", [715, 716]],
  ["JAYANTIKA EXPRESS", [717, 718]],
  ["PAHARIKA EXPRESS", [719, 720]],
  ["MAHANAGAR EXPRESS", [721, 722]],
  ["UDAYAN EXPRESS", [723, 724]],
  ["SUNDARBAN EXPRESS", [725, 726]],
  ["RUPSHA EXPRESS", [727, 728]],
  ["MEGHNA EXPRESS", [729, 730]],
  ["BARENDRA EXPRESS", [731, 732]],
  ["TITUMIR EXPRESS", [733, 734]],
  ["AGNIBINA EXPRESS", [735, 736]],
  ["EGAROSINDUR PROVATI", [737, 738]],
  ["UPABAN EXPRESS", [739, 740]],
  ["TURNA EXPRESS", [741, 742]],
  ["BRAHMAPUTRA EXPRESS", [743, 744]],
  ["JAMUNA EXPRESS", [745, 746]],
  ["SIMANTA EXPRESS", [747, 748]],
  ["EGAROSINDUR GODHULI", [749, 750]],
  ["LALMONI EXPRESS", [751, 752]],
  ["SILKCITY EXPRESS", [753, 754]],
  ["MADHUMATI EXPRESS", [755, 756]],
  ["DRUTOJAN EXPRESS", [757, 758]],
  ["PADMA EXPRESS", [759, 760]],
  ["RANGPUR EXPRESS", [771, 772]],
  ["HAOR EXPRESS", [777, 778]],
  ["DHALARCHAR EXPRESS", [779, 780]],
  ["KISHOREGANJ EXPRESS", [781, 782]],
  ["TUNGIPARA EXPRESS", [783, 784]],
  ["BIJOY EXPRESS", [785, 786]],
  ["SONAR BANGLA EXPRESS", [787, 788]],
  ["MOHANGANJ EXPRESS", [789, 790]],
  ["BANALATA EXPRESS", [791, 792]],
  ["PANCHAGARH EXPRESS", [793, 794]],
  ["BENAPOLE EXPRESS", [795, 796]],
  ["KURIGRAM EXPRESS", [797, 798]],
  ["JAMALPUR EXPRESS", [799, 800]],
  ["CHATTALA EXPRESS", [801, 802]],
  ["BANGLABANDHA EXPRESS", [803, 804]],
  ["CHILAHATI EXPRESS", [805, 806]],
  ["BURIMARI EXPRESS", [809, 810]],
  ["COX'S BAZAR EXPRESS", [813, 814]],
  ["PARJATAK EXPRESS", [815, 816]],
  ["PROBAL EXPRESS", [821, 822]],
  ["SHAIKAT EXPRESS", [823, 824]],
  ["JAHANABAD EXPRESS", [825, 826]],
  ["RUPOSHI BANGLA EXPRESS", [827, 828]]
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
    allowClassFallback: false,
    allowTrainFallback: false,
    allowCoachFallback: false,
    allowSeatFallback: false,
    continueToOtp: false,
    scheduleDate: todayISO(),
    scheduleHour: "08",
    scheduleMinute: "00",
    scheduleSecond: "00",
    scheduleMs: "000",
    schedulePeriod: new Date().getHours() >= 12 ? "PM" : "AM"
  };
}

function selectedSeats(quantity) {
  const seats = [];
  for (let index = 1; index <= quantity; index += 1) {
    const value = $(`seatPick${index}`).value.trim();
    if (value) seats.push(value);
  }
  return seats.join(", ");
}

function readForm() {
  const config = defaultConfig();
  for (const name of fields) {
    const el = $(name);
    if (name === "seatQuantity") config[name] = Number(el.value);
    else config[name] = el.value.trim();
  }
  config.preferredSeats = selectedSeats(config.seatQuantity);
  config.allowClassFallback = $("allowClassFallback").checked;
  config.allowTrainFallback = $("allowTrainFallback").checked;
  config.allowCoachFallback = $("allowCoachFallback").checked;
  config.allowSeatFallback = $("allowSeatFallback").checked;
  config.continueToOtp = $("continueToOtp").checked;
  config.scheduleHour = pad(config.scheduleHour, 2);
  config.scheduleMinute = pad(config.scheduleMinute, 2);
  config.scheduleSecond = pad(config.scheduleSecond, 2);
  config.scheduleMs = pad(config.scheduleMs, 3);
  return config;
}

function clockHour(hourValue, period) {
  const hour = Number(hourValue);
  if (!Number.isInteger(hour)) return NaN;
  if (hour > 12) return hour;
  if (period === "PM" && hour < 12) return hour + 12;
  if (period === "AM" && hour === 12) return 0;
  return hour;
}

function timestampFor(config, period) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(config.scheduleDate);
  if (!match) return NaN;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    clockHour(config.scheduleHour, period),
    Number(config.scheduleMinute),
    Number(config.scheduleSecond),
    Number(config.scheduleMs)
  ).getTime();
}

function inferPeriod(config) {
  if (config.schedulePeriod === "AM" || config.schedulePeriod === "PM") return config.schedulePeriod;
  const hour = Number(config.scheduleHour);
  if (hour > 12) return "PM";
  if (hour === 0) return "AM";
  const now = Date.now();
  const morning = timestampFor(config, "AM");
  const evening = timestampFor(config, "PM");
  if (morning > now) return "AM";
  if (evening > now) return "PM";
  return new Date().getHours() >= 12 ? "PM" : "AM";
}

function writeForm(config) {
  const merged = { ...defaultConfig(), ...(config || {}) };
  const savedPeriod = config && (config.schedulePeriod === "AM" || config.schedulePeriod === "PM");
  if (!savedPeriod) merged.schedulePeriod = inferPeriod({ ...merged, schedulePeriod: "" });
  for (const name of fields) {
    if (merged[name] === undefined || merged[name] === null) continue;
    const el = $(name);
    if (el.tagName === "SELECT") ensureOption(el, String(merged[name]));
    el.value = merged[name];
  }
  $("allowClassFallback").checked = Boolean(merged.allowClassFallback);
  $("allowTrainFallback").checked = Boolean(merged.allowTrainFallback);
  $("allowCoachFallback").checked = Boolean(merged.allowCoachFallback);
  $("allowSeatFallback").checked = Boolean(merged.allowSeatFallback);
  $("continueToOtp").checked = Boolean(merged.continueToOtp);
  rebuildSeatOptions(String(merged.preferredSeats || "").split(",").map((item) => item.trim()).filter(Boolean));
  syncSeatSlots();
}

function remapSeat(value, prefix) {
  if (!value) return "";
  const number = String(value).match(/(\d+)$/);
  if (!number) return value;
  return prefix ? `${prefix}-${Number(number[1])}` : String(Number(number[1]));
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
  const config = readForm();
  const url = searchUrl(config);
  $("url-preview").textContent = url || "Search URL appears after station, date, and class are set.";
  const target = computeTarget(config);
  const fire = $("fire-at");
  if (!Number.isFinite(target)) {
    fire.textContent = "";
    return;
  }
  const when = new Date(target).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
  fire.textContent = target > Date.now() ? `Fires at ${when}.` : `${when} is already in the past.`;
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
  const minute = Number(config.scheduleMinute);
  const second = Number(config.scheduleSecond);
  const ms = Number(config.scheduleMs);
  const hour = clockHour(config.scheduleHour, config.schedulePeriod);
  if (!inRange(hour, 0, 23) || !inRange(minute, 0, 59) || !inRange(second, 0, 59) || !inRange(ms, 0, 999)) {
    return "Trigger time must be HH 1–12 with AM/PM, MM/SS 0–59, MS 0–999.";
  }
  if (!config.scheduleDate) return "Trigger date is required.";
  const target = computeTarget(config);
  if (!Number.isFinite(target)) return "Trigger time is invalid.";
  if (target <= Date.now()) {
    const shown = new Date(target).toLocaleString("en-GB", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
    return `${shown} is already in the past. Pick a later minute, or switch AM/PM.`;
  }
  return "";
}

function computeTarget(config) {
  return timestampFor(config, config.schedulePeriod === "PM" ? "PM" : "AM");
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
  const running = phase !== "IDLE" && phase !== "ERROR" && phase !== "STOPPED_AT_OTP" && phase !== "STOPPED_AT_CONTINUE";
  $("arm-btn").hidden = running;
  $("save-btn").hidden = running;
  return phase;
}

let latestState = null;

function tickCountdown() {
  const phase = latestState?.phase;
  if (phase === "ARMED" && latestState.targetTimestamp) {
    $("countdown").textContent = formatCountdown(latestState.targetTimestamp - Date.now());
  } else if (phase === "STOPPED_AT_OTP" || phase === "STOPPED_AT_CONTINUE") {
    $("countdown").textContent = "Stopped";
  } else if (phase === "ERROR") {
    $("countdown").textContent = "Stopped";
  } else {
    $("countdown").textContent = "—";
  }
}

function addOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function ensureOption(select, value) {
  if (!value || [...select.options].some((option) => option.value === value)) return;
  addOption(select, value, value);
}

function fillChoices() {
  const stations = Array.isArray(RAIL_STATIONS) ? RAIL_STATIONS : [];
  for (const id of ["fromStation", "toStation"]) {
    const select = $(id);
    select.replaceChildren();
    addOption(select, "", "Select station");
    stations.forEach((name) => addOption(select, name, name));
  }
  const trains = $("targetTrain");
  trains.replaceChildren();
  addOption(trains, "", "Select train");
  TRAINS.forEach(([name, numbers]) => {
    numbers.forEach((number) => addOption(trains, `${name} (${number})`, `${name} (${number})`));
  });

  const coach = $("preferredCoach");
  coach.replaceChildren();
  addOption(coach, "", "Any coach");
  COACHES.filter(Boolean).forEach((code) => addOption(coach, code, code));
  rebuildSeatOptions();
  syncSeatSlots();
}

function rebuildSeatOptions(savedSeats) {
  const prefix = $("preferredCoach").value.trim().toUpperCase();
  const saved = savedSeats || [1, 2, 3, 4].map((index) => remapSeat($(`seatPick${index}`).value, prefix));
  for (let index = 1; index <= 4; index += 1) {
    const select = $(`seatPick${index}`);
    const keep = saved[index - 1] || "";
    select.replaceChildren();
    addOption(select, "", "None");
    for (let number = 1; number <= SEAT_COUNT; number += 1) {
      const label = prefix ? `${prefix}-${number}` : String(number);
      addOption(select, label, label);
    }
    ensureOption(select, keep);
    select.value = keep;
  }
}

function syncSeatSlots() {
  const quantity = Number($("seatQuantity").value) || 1;
  for (let index = 1; index <= 4; index += 1) {
    const label = $(`seatPick${index}`).closest("label");
    const hidden = index > quantity;
    label.hidden = hidden;
    if (hidden) $(`seatPick${index}`).value = "";
  }
}

async function refresh() {
  const stored = await chrome.storage.local.get([STATE_KEY, LOG_KEY]);
  latestState = stored[STATE_KEY] || { phase: "IDLE" };
  renderStatus(latestState, stored[LOG_KEY]);
  tickCountdown();
}

document.addEventListener("DOMContentLoaded", async () => {
  fillChoices();
  $("preferredCoach").addEventListener("change", () => rebuildSeatOptions());
  $("seatQuantity").addEventListener("change", syncSeatSlots);
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

if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STATE_KEY] || changes[LOG_KEY]) refresh();
  });
}

setInterval(tickCountdown, 50);
