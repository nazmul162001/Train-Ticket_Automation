const STATE_KEY = "railBookerState";
const LOG_KEY = "railBookerLogs";
const ALARM = "rail-booker-wake";
const HOME_URL = "https://eticket.railway.gov.bd/";
const SITE_MATCH = "https://eticket.railway.gov.bd/*";
const WAKE_BEFORE_MS = 5000;
const EARLY_WAKE_MS = 30000;
const LOG_LIMIT = 50;

let armedToken = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || { phase: "IDLE" };
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

async function log(message, level = "info") {
  const stored = await chrome.storage.local.get(LOG_KEY);
  const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  logs.push({ t: Date.now(), level, message });
  while (logs.length > LOG_LIMIT) logs.shift();
  await chrome.storage.local.set({ [LOG_KEY]: logs });
}

function cancelLoop() {
  armedToken += 1;
}

async function disarm(reason) {
  cancelLoop();
  await chrome.alarms.clear(ALARM);
  await setState({
    phase: "IDLE",
    targetTimestamp: null,
    firedAt: null,
    driftMs: null,
    lastError: null
  });
  if (reason) await log(reason);
}

/**
 * chrome.alarms is only a wake-up. The last stretch uses a monotonic
 * setTimeout loop so the click is scheduled against performance.now()
 * instead of a one-shot timer that can slip.
 */
function startPrecisionLoop(targetTimestamp) {
  const token = ++armedToken;
  const baseWall = Date.now();
  const basePerf = performance.now();

  const tick = () => {
    if (token !== armedToken) return;
    const wall = baseWall + (performance.now() - basePerf);
    const remaining = targetTimestamp - wall;
    if (remaining <= 2) {
      fire(targetTimestamp, token);
      return;
    }
    let wait;
    if (remaining > 1000) wait = 200;
    else if (remaining > 80) wait = 15;
    else wait = Math.max(0, remaining - 2);
    setTimeout(tick, wait);
  };

  tick();
}

async function scheduleWake(targetTimestamp) {
  await chrome.alarms.clear(ALARM);
  const remaining = targetTimestamp - Date.now();
  if (remaining <= WAKE_BEFORE_MS + 1000) {
    await log(`Precision loop started (${remaining} ms remaining).`);
    startPrecisionLoop(targetTimestamp);
    return;
  }
  const lead = remaining > EARLY_WAKE_MS + 5000 ? EARLY_WAKE_MS : WAKE_BEFORE_MS;
  const when = targetTimestamp - lead;
  await chrome.alarms.create(ALARM, { when });
  await log(`Alarm set ${lead} ms before trigger (${new Date(when).toLocaleTimeString()}).`);
}

async function fire(targetTimestamp, token) {
  if (token !== armedToken) return;
  cancelLoop();
  const state = await getState();
  if (state.phase !== "ARMED" || state.targetTimestamp !== targetTimestamp) return;

  const firedAt = Date.now();
  const driftMs = firedAt - targetTimestamp;
  await setState({ phase: "SEARCHING", firedAt, driftMs, lastError: null });
  const sign = driftMs > 0 ? "+" : "";
  await log(`Trigger fired. Drift ${sign}${driftMs} ms (target ${targetTimestamp}, fired ${firedAt}).`);

  try {
    await triggerTab();
  } catch (error) {
    await setState({
      phase: "ERROR",
      lastError: error.message || String(error)
    });
    await log(`ERROR at trigger: ${error.message || error}`, "error");
  }
}

function waitForComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for the railway tab to load."));
    }, 20000);

    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

async function sendStart(tabId) {
  let injected = false;
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "START_SEARCH" });
      if (response?.ok) return;
      lastError = new Error(response?.error || "Content script did not accept START_SEARCH.");
    } catch (error) {
      lastError = error;
      if (!injected) {
        injected = true;
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["utils/selectors.js", "content.js"]
        });
      }
    }
    await delay(300);
  }
  throw lastError || new Error("Could not message the railway tab.");
}

async function triggerTab() {
  const tabs = await chrome.tabs.query({ url: SITE_MATCH });
  let tab = tabs.find((item) => item.active) || tabs[0];
  if (!tab) {
    await log("No railway tab open. Opening the home page.");
    tab = await chrome.tabs.create({ url: HOME_URL, active: true });
    await waitForComplete(tab.id);
  } else {
    await log(`Using open railway tab ${tab.id}.`);
  }
  await sendStart(tab.id);
  await log("Told the page to start searching.");
}

async function resumeIfArmed() {
  const state = await getState();
  if (state.phase !== "ARMED" || !state.targetTimestamp) return;
  const remaining = state.targetTimestamp - Date.now();
  if (remaining < -2000) {
    await setState({
      phase: "ERROR",
      lastError: "Trigger time passed before the extension could fire."
    });
    await log("ERROR: trigger time passed while the extension was asleep.", "error");
    return;
  }
  await scheduleWake(state.targetTimestamp);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ARM") {
    arm(message.targetTimestamp)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "DISARM") {
    disarm("Disarmed by user.")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return false;
});

async function arm(targetTimestamp) {
  if (!Number.isFinite(targetTimestamp)) throw new Error("Invalid trigger time.");
  if (targetTimestamp <= Date.now()) throw new Error("Trigger time is already in the past.");
  cancelLoop();
  await chrome.alarms.clear(ALARM);
  await setState({
    phase: "ARMED",
    targetTimestamp,
    firedAt: null,
    driftMs: null,
    lastError: null,
    formFallbackTried: false
  });
  await log(`Armed for ${new Date(targetTimestamp).toLocaleString()}.`);
  await scheduleWake(targetTimestamp);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  getState().then((state) => {
    if (state.phase !== "ARMED" || !state.targetTimestamp) return;
    log("Alarm woke the extension. Starting the precision loop.");
    startPrecisionLoop(state.targetTimestamp);
  });
});

resumeIfArmed();
