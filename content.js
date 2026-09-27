/**
 * Train Ticket Automation page driver.
 *
 * Hard stop: this file never reads, writes, or submits an OTP field,
 * never reads SMS or the clipboard, and never clicks Verify or payment.
 */
(() => {
  if (window !== window.top) return;

  const STATE_KEY = "railBookerState";
  const CONFIG_KEY = "railBookerConfig";
  const LOG_KEY = "railBookerLogs";
  const TICKET_KEY = "railBookerTicket";
  const LOG_LIMIT = 50;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const TERMINAL = new Set(["IDLE", "STOPPED_AT_OTP", "STOPPED_AT_CONTINUE", "ERROR"]);

  let busy = false;
  let rerun = false;
  let unloaded = false;
  let otpWatcher = null;
  let otpTimer = null;
  let historyHooked = false;
  let summaryOpened = false;
  const ACTIVE = new Set(["ARMED", "SEARCHING", "RESULTS", "SEAT_SELECT", "CONTINUE_CLICKED"]);

  window.addEventListener("pagehide", () => {
    unloaded = true;
  });

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getState() {
    const stored = await chrome.storage.local.get(STATE_KEY);
    return stored[STATE_KEY] || { phase: "IDLE" };
  }

  async function getConfig() {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    return stored[CONFIG_KEY] || null;
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

  async function fail(step, selector, error) {
    if (unloaded) return;
    const state = await getState();
    if (state.phase === "ERROR" || state.phase === "STOPPED_AT_OTP" || state.phase === "STOPPED_AT_CONTINUE") return;
    const detail = error?.message || String(error || "unknown error");
    const message = `ERROR at ${step}${selector ? ` [${selector}]` : ""}: ${detail}`;
    await log(message, "error");
    await setState({ phase: "ERROR", lastError: message });
  }

  function waitFor(predicate, timeout = 8000, interval = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (unloaded) {
          resolve(null);
          return;
        }
        let value = null;
        try {
          value = predicate();
        } catch (error) {
          resolve(null);
          return;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - start >= timeout) {
          resolve(null);
          return;
        }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function waitForSelector(selector, timeout = 8000) {
    const found = document.querySelector(selector);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(unloaded ? null : document.querySelector(selector));
      }, timeout);
    });
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function textOf(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function pageKind() {
    const path = location.pathname || "/";
    if (isOtpScreen()) return "otp";
    if (SELECTORS.payment.path.test(path)) return "payment";
    if (path.includes("/booking/train/search")) return "results";
    if (path.includes("/booking/train/trip-info") || document.querySelector("app-purchase, app-passenger-details")) {
      return "purchase";
    }
    if (path === "/login" || path.startsWith("/login")) return "login";
    if (document.querySelector(SELECTORS.home.form)) return "home";
    return "other";
  }

  function isOtpScreen() {
    return Boolean(document.querySelector(SELECTORS.otp.container));
  }

  function isBlockedDialog(text) {
    return /otp|verify code|payment|bkash|nagad|rocket|visa|mastercard|card number/i.test(text);
  }

  async function dismissSafeDialog() {
    const popup = document.querySelector(SELECTORS.dialog.container);
    if (!popup) return false;
    const text = `${textOf(popup.querySelector(SELECTORS.dialog.title))} ${textOf(popup.querySelector(SELECTORS.dialog.body))}`;
    if (isBlockedDialog(text)) {
      await fail("dialog", SELECTORS.dialog.container, "A verification or payment dialog appeared. Stopping.");
      return true;
    }
    const confirm = popup.querySelector(SELECTORS.dialog.confirm);
    if (confirm && /verify/i.test(textOf(confirm))) {
      await fail("dialog", SELECTORS.dialog.confirm, "Refusing to click a Verify button.");
      return true;
    }
    if (confirm) confirm.click();
    await delay(200);
    return false;
  }

  function formatDoj(isoDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
    if (!match) return "";
    return `${match[3]}-${MONTHS[Number(match[2]) - 1]}-${match[1]}`;
  }

  function buildSearchUrl(config) {
    const doj = formatDoj(config.journeyDate);
    if (!config.fromStation || !config.toStation || !doj || !config.trainClass) {
      throw new Error("Search config is incomplete.");
    }
    const params = new URLSearchParams({
      fromcity: config.fromStation,
      tocity: config.toStation,
      doj,
      class: config.trainClass
    });
    return `https://eticket.railway.gov.bd/booking/train/search?${params.toString()}`;
  }

  async function saveTicket(patch) {
    const stored = await chrome.storage.local.get(TICKET_KEY);
    const current = stored[TICKET_KEY] || {};
    const next = { ...current };
    Object.entries(patch || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      if (Array.isArray(value) && value.length === 0) return;
      if (Array.isArray(value)) {
        next[key] = value;
        return;
      }
      next[key] = typeof value === "string" ? value : String(value);
    });
    next.updatedAt = Date.now();
    await chrome.storage.local.set({ [TICKET_KEY]: next });
    return next;
  }

  async function addFallbackNote(line) {
    const stored = await chrome.storage.local.get(TICKET_KEY);
    const current = stored[TICKET_KEY]?.fallbackNote || "";
    const note = current ? `${current} ${line}` : line;
    await saveTicket({ fallbackNote: note });
  }

  async function beginTicket(config) {
    const number = String(config.targetTrain || "").match(/\((\d+)\)/);
    await chrome.storage.local.set({
      [TICKET_KEY]: {
        from: config.fromStation || "",
        to: config.toStation || "",
        journeyDate: config.journeyDate || "",
        trainName: config.targetTrain || "",
        trainNumber: number ? number[1] : "",
        trainClass: config.trainClass || "",
        coach: "",
        seats: [],
        depart: "",
        arrive: "",
        travelTime: "",
        fare: "",
        currency: "৳",
        updatedAt: Date.now()
      }
    });
  }

  function plain(value) {
    if (value == null) return "";
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return value.trim();
    return "";
  }

  function hasClock(value) {
    return /\d{1,2}:\d{2}/.test(plain(value));
  }

  function purchaseModel() {
    const host = document.querySelector("app-purchase");
    const context = host?.__ngContext__;
    if (!Array.isArray(context)) return null;
    const seen = new Set();
    const walk = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 6 || seen.has(value) || value.nodeType) return null;
      seen.add(value);
      if (value.selectedTrip && plain(value.selectedTrip.trip_number)) return value;
      let keys = [];
      try {
        keys = Object.keys(value).slice(0, 80);
      } catch (_error) {
        return null;
      }
      for (const key of keys) {
        if (/otp/i.test(key)) continue;
        try {
          const found = walk(value[key], depth + 1);
          if (found) return found;
        } catch (_error) {
          /* Angular internals can throw on getters. */
        }
      }
      return null;
    };
    for (const entry of context) {
      const found = walk(entry, 0);
      if (found) return found;
    }
    return null;
  }

  function visibleDeparture() {
    const nodes = [...document.querySelectorAll("li, p, div")];
    for (const node of nodes) {
      if (node.querySelector("input, textarea")) continue;
      const label = node.querySelector(":scope > span");
      if (!label || !textOf(label).toLowerCase().startsWith("departure")) continue;
      const clone = node.cloneNode(true);
      clone.querySelectorAll("span").forEach((span) => span.remove());
      const value = textOf(clone);
      if (hasClock(value)) return value;
    }
    return "";
  }

  async function writeFinalTicket(config) {
    const stored = await chrome.storage.local.get(TICKET_KEY);
    const saved = stored[TICKET_KEY] || {};
    const model = purchaseModel();
    const trip = model?.selectedTrip || {};
    const gotNumber = plain(trip.trip_number);
    const wantedNumber = (String(config?.targetTrain || "").match(/\((\d+)\)/) || [])[1] || "";
    const usedFallbackTrain = saved.fallbackTrain === "yes" || saved.fallbackTrain === true;
    const savedNumber = plain(saved.trainNumber);
    const matchesSaved = !gotNumber || !savedNumber || gotNumber === savedNumber;
    const matchesRequested = !wantedNumber || !gotNumber || wantedNumber === gotNumber;
    const sameTrain = matchesRequested || (usedFallbackTrain && matchesSaved);
    const reserved = Array.isArray(model?.reservedSeats) ? model.reservedSeats : [];
    const selected = Array.isArray(model?.selectedSeats) ? model.selectedSeats : [];
    const seats = (reserved.length ? reserved : selected)
      .map((seat) => plain(seat?.seat_number || seat?.label))
      .filter(Boolean);
    const shownDepart = visibleDeparture();
    const sameSaved = !gotNumber || gotNumber === plain(saved.trainNumber);
    const depart = shownDepart || plain(trip.departure_date_time) || (sameSaved ? saved.depart : "");
    const arrive = plain(trip.arrival_date_time) || (sameSaved ? saved.arrive : "");
    const travelTime = plain(trip.travel_time) || (sameSaved ? saved.travelTime : "");
    const ticket = {
      from: plain(trip.origin_city_name) || (sameTrain ? saved.from : ""),
      to: plain(trip.destination_city_name) || (sameTrain ? saved.to : ""),
      depart,
      arrive,
      travelTime,
      journeyDate: saved.journeyDate || config?.journeyDate || "",
      trainName: plain(trip.train_model) || (sameTrain ? saved.trainName : ""),
      trainNumber: gotNumber || (sameTrain ? saved.trainNumber : ""),
      trainClass: plain(model?.selectedSeatClass?.type) || (sameTrain ? saved.trainClass : ""),
      coach: plain(model?.selectedCoach?.floor_name) || (sameTrain ? saved.coach : ""),
      seats: seats.length ? seats : (sameTrain ? saved.seats || [] : []),
      fare: Number(model?.ticketFare?.orderValue) > 0 ? String(model.ticketFare.orderValue) : "",
      currency: plain(model?.currencySign) || "৳",
      requestedTrain: config?.targetTrain || "",
      fallbackNote: saved.fallbackNote || "",
      fallbackTrain: usedFallbackTrain ? "yes" : "",
      mismatch: Boolean(gotNumber && !matchesRequested && !(usedFallbackTrain && matchesSaved)),
      manualContinue: config?.continueToOtp !== true,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [TICKET_KEY]: ticket });
    await log(`OTP trip ${ticket.trainName} (${ticket.trainNumber}): ${ticket.depart || "no departure"} → ${ticket.arrive || "no arrival"} (${ticket.travelTime || "no duration"}).`);
    if (ticket.mismatch) {
      await log(`Wrong train. Requested ${ticket.requestedTrain}, page has ${ticket.trainNumber}. Do not enter the OTP.`, "error");
    }
    return ticket;
  }

  function stopOtpWatch() {
    if (otpWatcher) {
      otpWatcher.disconnect();
      otpWatcher = null;
    }
    if (otpTimer) {
      clearInterval(otpTimer);
      otpTimer = null;
    }
  }

  async function openSummary(phase, message) {
    if (summaryOpened || unloaded) return;
    summaryOpened = true;
    const state = await getState();
    if (!ACTIVE.has(state.phase)) {
      summaryOpened = false;
      return;
    }
    stopOtpWatch();
    try {
      await writeFinalTicket(await getConfig());
    } catch (error) {
      await log(`Could not read the booked trip: ${error?.message || error}.`, "error");
    }
    await log(message);
    await setState({ phase, lastError: null });
    try {
      const response = await chrome.runtime.sendMessage({ type: "SHOW_SUMMARY" });
      if (!response?.ok) await log(`Summary window did not open: ${response?.error || "unknown error"}.`, "error");
    } catch (error) {
      await log(`Summary window did not open: ${error?.message || error}.`, "error");
    }
  }

  async function stopAtOtp() {
    await openSummary("STOPPED_AT_OTP", "OTP screen is open. Automation stopped. Check the summary before you enter the code.");
  }

  async function stopBeforeContinue() {
    await openSummary("STOPPED_AT_CONTINUE", "Seats are selected. Click Continue Purchase yourself. Automation stopped.");
  }

  async function maybeStopForOtp() {
    if (summaryOpened || unloaded) return;
    if (!isOtpScreen()) {
      if (!SELECTORS.payment.path.test(location.pathname || "")) return;
      const state = await getState();
      if (state.phase === "CONTINUE_CLICKED" || state.phase === "SEAT_SELECT") {
        await fail("CONTINUE_CLICKED", "payment-url", "Payment page detected. Automation stopped without paying.");
      }
      return;
    }
    await stopAtOtp();
  }

  function armOtpWatch() {
    if (!historyHooked) {
      historyHooked = true;
      const notify = () => { maybeStopForOtp(); };
      const push = history.pushState.bind(history);
      const replace = history.replaceState.bind(history);
      history.pushState = (...args) => {
        const result = push(...args);
        notify();
        return result;
      };
      history.replaceState = (...args) => {
        const result = replace(...args);
        notify();
        return result;
      };
      window.addEventListener("popstate", notify);
    }
    if (!otpWatcher && document.documentElement) {
      otpWatcher = new MutationObserver(() => {
        maybeStopForOtp();
      });
      otpWatcher.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (!otpTimer) otpTimer = setInterval(() => { maybeStopForOtp(); }, 400);
    maybeStopForOtp();
  }

  async function clickAgreeIfPresent() {
    const button = [...document.querySelectorAll("button")].find((item) => textOf(item) === "I AGREE");
    if (!button) return;
    button.click();
    await delay(300);
  }

  async function chooseSuggestion(input, station) {
    input.focus();
    input.readOnly = false;
    setNativeValue(input, "");
    const letters = station.split("");
    let typed = "";
    for (const letter of letters) {
      typed += letter;
      setNativeValue(input, typed);
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: letter }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: letter }));
      await delay(40);
    }
    const menu = await waitFor(() => {
      const items = [...document.querySelectorAll(SELECTORS.home.suggestionItem)];
      return items.find((item) => textOf(item).toLowerCase() === station.toLowerCase()) || null;
    }, 4000, 80);
    if (!menu) throw new Error(`No autocomplete match for "${station}".`);
    menu.click();
    await delay(200);
    if ((input.value || "").toLowerCase() !== station.toLowerCase()) {
      throw new Error(`Station field stayed "${input.value}" after choosing "${station}".`);
    }
  }

  async function fillDate(isoDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    if (!match) throw new Error("Journey date is invalid.");
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const monthName = new Date(year, monthIndex, 1).toLocaleString("en-US", { month: "long" });
    const input = document.querySelector(SELECTORS.home.dateInput);
    if (!input) throw new Error("Date field missing.");
    input.click();
    const opened = await waitForSelector(SELECTORS.home.datepicker, 3000);
    if (!opened) throw new Error("Date picker did not open.");

    for (let guard = 0; guard < 14; guard += 1) {
      const shownMonth = textOf(document.querySelector(SELECTORS.home.datepickerMonth));
      const shownYear = Number(textOf(document.querySelector(SELECTORS.home.datepickerYear)));
      if (shownMonth === monthName && shownYear === year) break;
      const shownIndex = new Date(`${shownMonth} 1, ${shownYear}`).getMonth();
      const forward = year > shownYear || (year === shownYear && monthIndex > shownIndex);
      const control = document.querySelector(forward ? SELECTORS.home.datepickerNext : SELECTORS.home.datepickerPrev);
      if (!control) throw new Error("Date picker has no month controls.");
      control.click();
      await delay(120);
    }

    const dayLink = [...document.querySelectorAll(SELECTORS.home.datepickerDay)].find((link) => {
      const cell = link.closest("td");
      return Number(textOf(link)) === day
        && Number(cell?.getAttribute("data-month")) === monthIndex
        && Number(cell?.getAttribute("data-year")) === year;
    });
    if (!dayLink) throw new Error(`Could not find ${day} ${monthName} ${year} in the calendar.`);
    dayLink.click();
    await delay(150);
  }

  async function fillSearchForm(config) {
    await clickAgreeIfPresent();
    const from = document.querySelector(SELECTORS.home.fromInput);
    const to = document.querySelector(SELECTORS.home.toInput);
    const classSelect = document.querySelector(SELECTORS.home.classSelect);
    const submit = document.querySelector(SELECTORS.home.submit);
    if (!from || !to || !classSelect || !submit) {
      throw new Error("Search form controls are missing.");
    }
    await log("Form fallback: filling From station.");
    await chooseSuggestion(from, config.fromStation);
    await log("Form fallback: filling To station.");
    await chooseSuggestion(to, config.toStation);
    await log("Form fallback: picking the journey date.");
    await fillDate(config.journeyDate);
    setNativeValue(classSelect, config.trainClass);
    if (classSelect.value !== config.trainClass) {
      throw new Error(`Class option ${config.trainClass} was not accepted.`);
    }
    const enabled = await waitFor(() => (submit.disabled ? null : submit), 2000);
    if (!enabled) throw new Error("Search button stayed disabled.");
    await setState({ phase: "RESULTS", formFallbackTried: true });
    await log("Form fallback: clicking Search Trains.");
    submit.click();
  }

  async function runSearching(config, state) {
    const kind = pageKind();
    if (kind === "otp") {
      await stopAtOtp();
      return;
    }
    if (kind === "login") {
      await fail("SEARCHING", location.pathname, "Login required. Sign in yourself, then arm again.");
      return;
    }
    if (kind === "results") {
      await beginTicket(config);
      await setState({ phase: "RESULTS" });
      await runResults(config);
      return;
    }
    if (state.formFallbackTried) {
      await fillSearchForm(config);
      return;
    }
    const url = buildSearchUrl(config);
    await beginTicket(config);
    await log(`Opening search results: ${url}`);
    await setState({ phase: "RESULTS", searchUrl: url });
    location.href = url;
  }

  function tripRecord(card) {
    const context = card.__ngContext__;
    if (!Array.isArray(context)) return null;
    const seen = new Set();
    const walk = (value, depth) => {
      if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return null;
      seen.add(value);
      if (value.trip_number && (value.train_model || value.seat_types)) return value;
      const keys = Object.keys(value).slice(0, 25);
      for (const key of keys) {
        try {
          const found = walk(value[key], depth + 1);
          if (found) return found;
        } catch (_error) {
          /* Angular internals can throw on getters. */
        }
      }
      return null;
    };
    for (const entry of context) {
      const found = walk(entry, 0);
      if (found) return found;
    }
    return null;
  }

  function cardMatches(card, needle) {
    const trip = tripRecord(card);
    const heading = textOf(card.querySelector(SELECTORS.results.trainName));
    const blob = `${heading} ${trip?.trip_number || ""} ${trip?.train_model || ""}`;
    const number = String(needle).match(/\((\d+)\)/);
    if (number) return new RegExp(`(^|[^0-9])${number[1]}([^0-9]|$)`).test(blob);
    return blob.toLowerCase().includes(String(needle).trim().toLowerCase());
  }

  const CLASS_ORDER = ["AC_B", "AC_S", "SNIGDHA", "F_BERTH", "F_SEAT", "F_CHAIR", "S_CHAIR", "SHOVAN", "SHULOV", "AC_CHAIR"];

  function classCodeFromText(value) {
    const raw = String(value || "").trim().toUpperCase();
    const aliases = {
      "AC BERTH": "AC_B",
      "AC SEAT": "AC_S",
      "AC CHAIR": "AC_CHAIR",
      "FIRST BERTH": "F_BERTH",
      "FIRST SEAT": "F_SEAT",
      "FIRST CHAIR": "F_CHAIR",
      "SHOVON CHAIR": "S_CHAIR",
      SHOVON: "SHOVAN"
    };
    return aliases[raw] || raw;
  }

  function classColumn(card, trainClass) {
    const wanted = classCodeFromText(trainClass);
    const columns = [...card.querySelectorAll(SELECTORS.results.classColumn)];
    return columns.find((column) => classCodeFromText(textOf(column.querySelector(SELECTORS.results.className))) === wanted) || null;
  }

  function availableCount(column) {
    const nodes = [...column.querySelectorAll(SELECTORS.results.availableCount)];
    for (const node of nodes) {
      const raw = textOf(node);
      if (/^\d+$/.test(raw)) return Number(raw);
    }
    return null;
  }

  function columnIsBookable(column) {
    if (!column) return false;
    const book = column.querySelector(SELECTORS.results.bookNow);
    if (!book || book.disabled) return false;
    if (column.querySelector(SELECTORS.results.unavailableWrap)) return false;
    return availableCount(column) !== 0;
  }

  function classEntries(card) {
    return [...card.querySelectorAll(SELECTORS.results.classColumn)].map((column) => ({
      column,
      name: classCodeFromText(textOf(column.querySelector(SELECTORS.results.className))),
      count: availableCount(column),
      bookable: columnIsBookable(column)
    })).filter((item) => item.name);
  }

  function rankBookable(entries, quantity) {
    return entries.filter((item) => item.bookable).sort((a, b) => {
      const aFit = a.count === null || a.count >= quantity ? 1 : 0;
      const bFit = b.count === null || b.count >= quantity ? 1 : 0;
      return bFit - aFit || (b.count || 0) - (a.count || 0);
    });
  }

  function selectionFor(card, config) {
    const requested = classCodeFromText(config.trainClass);
    const quantity = Number(config.seatQuantity) || 1;
    const entries = classEntries(card);
    const wanted = entries.find((item) => item.name === requested && item.bookable);
    if (wanted) return { entry: wanted, classFallback: false, entries };
    if (!config.allowClassFallback) return { entry: null, classFallback: false, entries };
    const ranked = rankBookable(entries, quantity);
    if (!ranked.length) return { entry: null, classFallback: false, entries };
    return { entry: ranked[0], classFallback: ranked[0].name !== requested, entries };
  }

  async function openClassSearch(config, trainClass, triedClasses) {
    const url = buildSearchUrl({ ...config, trainClass });
    await log(`Checking class ${trainClass} for ${config.targetTrain}.`);
    await setState({ phase: "RESULTS", activeClass: trainClass, triedClasses, searchUrl: url });
    location.href = url;
  }

  async function runResults(config) {
    if (pageKind() === "login") {
      await fail("RESULTS", location.pathname, "Redirected to login. Sign in yourself, then arm again.");
      return;
    }
    if (pageKind() === "home") {
      const state = await getState();
      if (!state.formFallbackTried) {
        await log("Results URL did not leave the home page. Trying the search form.");
        await setState({ phase: "SEARCHING", formFallbackTried: true });
        await fillSearchForm(config);
        return;
      }
      await fail("RESULTS", SELECTORS.home.form, "Still on the home page after the search URL and form fallback.");
      return;
    }

    const needle = (config.targetTrain || "").trim().toLowerCase();
    if (!needle) {
      await fail("RESULTS", SELECTORS.results.trainList, "Target train is empty.");
      return;
    }

    const list = await waitForSelector(SELECTORS.results.trainList, 8000);
    if (!list) {
      await fail("RESULTS", SELECTORS.results.trainList, "Train list did not render within 8s.");
      return;
    }

    const state = await getState();
    const cards = [...document.querySelectorAll(SELECTORS.results.trainList)];
    const requestedClass = classCodeFromText(config.trainClass);
    const tried = new Set((state.triedClasses || []).map((item) => classCodeFromText(item)));
    tried.add(requestedClass);
    if (state.activeClass) tried.add(classCodeFromText(state.activeClass));

    const target = cards.find((item) => cardMatches(item, needle));
    let card = target || null;
    let choice = target ? selectionFor(target, config) : null;

    if (target && !choice.entry && config.allowClassFallback && choice.entries.length <= 1) {
      const next = CLASS_ORDER.find((name) => !tried.has(name));
      if (next) {
        tried.add(next);
        await openClassSearch(config, next, [...tried]);
        return;
      }
    }

    if (!target && !config.allowTrainFallback && config.allowClassFallback) {
      const next = CLASS_ORDER.find((name) => !tried.has(name));
      if (next) {
        tried.add(next);
        await openClassSearch(config, next, [...tried]);
        return;
      }
    }

    if ((!card || !choice?.entry) && config.allowTrainFallback) {
      const quantity = Number(config.seatQuantity) || 1;
      const others = cards
        .filter((item) => item !== target)
        .map((item) => ({ item, choice: selectionFor(item, config) }))
        .filter((item) => item.choice.entry)
        .sort((a, b) => {
          if (a.choice.classFallback !== b.choice.classFallback) return a.choice.classFallback ? 1 : -1;
          const aCount = a.choice.entry.count || 0;
          const bCount = b.choice.entry.count || 0;
          const aFit = a.choice.entry.count === null || aCount >= quantity ? 1 : 0;
          const bFit = b.choice.entry.count === null || bCount >= quantity ? 1 : 0;
          return bFit - aFit || bCount - aCount;
        });
      if (others.length) {
        card = others[0].item;
        choice = others[0].choice;
      }
    }

    if (!choice?.entry && config.allowClassFallback) {
      const singleColumn = !target || choice.entries.length <= 1;
      const next = singleColumn ? CLASS_ORDER.find((name) => !tried.has(name)) : null;
      if (next) {
        tried.add(next);
        await openClassSearch(config, next, [...tried]);
        return;
      }
    }

    if (!choice?.entry) {
      if (!target) {
        const extra = config.allowTrainFallback ? ", and no other train has seats" : "";
        await fail("RESULTS", SELECTORS.results.trainName, `No train matched "${config.targetTrain}"${extra}.`);
        return;
      }
      const wantedColumn = classColumn(target, requestedClass);
      const count = wantedColumn ? availableCount(wantedColumn) : null;
      let detail = `No online seats for ${config.trainClass}${count === null ? "" : ` (count ${count})`}.`;
      if (!config.allowClassFallback) detail += ` Tick "Any class if this one is full" to use another class.`;
      else if (!config.allowTrainFallback) detail += ` No other class on this train has seats.`;
      else detail += ` No other class or train has seats.`;
      await fail("RESULTS", SELECTORS.results.bookNow, detail);
      return;
    }

    const column = choice.entry.column;
    const bookedClass = choice.entry.name;
    const trainFallback = card !== target;
    const book = column.querySelector(SELECTORS.results.bookNow);
    if (!book) {
      await fail("RESULTS", SELECTORS.results.bookNow, `Book Now is missing for ${bookedClass}.`);
      return;
    }

    const trip = tripRecord(card) || {};
    const heading = textOf(card.querySelector(SELECTORS.results.trainName));
    const shownStart = card.querySelector(SELECTORS.results.journeyStart);
    const shownEnd = card.querySelector(SELECTORS.results.journeyEnd);
    const shownDepart = textOf(shownStart?.querySelector(SELECTORS.results.journeyDate));
    const shownArrive = textOf(shownEnd?.querySelector(SELECTORS.results.journeyDate));
    const shownDuration = textOf(card.querySelector(SELECTORS.results.journeyDuration));
    const numberText = textOf(card.querySelector(SELECTORS.results.trainNumber));
    const headingNumber = (heading.match(/\((\d+)\)/) || [])[1] || (/^\d+$/.test(numberText) ? numberText : "");
    const requestedNumber = (String(config.targetTrain).match(/\((\d+)\)/) || [])[1] || "";
    const bookedNumber = plain(trip.trip_number) || headingNumber || (trainFallback ? "" : requestedNumber);
    const bookedName = plain(trip.train_model) || heading || (trainFallback ? "fallback train" : config.targetTrain);
    await saveTicket({
      from: textOf(shownStart?.querySelector(SELECTORS.results.journeyLocation)) || trip.origin_city_name || config.fromStation,
      to: textOf(shownEnd?.querySelector(SELECTORS.results.journeyLocation)) || trip.destination_city_name || config.toStation,
      depart: shownDepart || plain(trip.departure_date_time) || [plain(trip.departure_date), plain(trip.departure_time)].filter(Boolean).join(" "),
      arrive: shownArrive || plain(trip.arrival_date_time),
      travelTime: shownDuration || plain(trip.travel_time),
      trainName: bookedName,
      trainNumber: bookedNumber,
      trainClass: bookedClass,
      requestedTrain: config.targetTrain,
      fallbackTrain: trainFallback ? "yes" : "",
      mismatch: false
    });
    if (trainFallback) {
      await addFallbackNote(`Train ${config.targetTrain} had no seats. Booked ${bookedName}${bookedNumber ? ` (${bookedNumber})` : ""}.`);
    }
    if (choice.classFallback) {
      await addFallbackNote(`Class ${config.trainClass} was full. Booked ${bookedClass}.`);
    }
    await log(`Booking ${bookedName} / ${bookedClass}. Card time ${shownDepart || "missing"} → ${shownArrive || "missing"} (${shownDuration || "missing"}).`);
    await setState({ phase: "SEAT_SELECT", activeClass: "", triedClasses: [] });
    book.click();
    const layout = await waitForSelector(SELECTORS.seats.layout, 8000);
    if (!layout) {
      await fail("SEAT_SELECT", SELECTORS.seats.layout, "Seat map did not open within 8s.");
      return;
    }
    await runSeatSelect({ ...config, trainClass: bookedClass });
  }

  function seatIdentity(button) {
    return (button.getAttribute("title") || button.textContent || "").replace(/\s+/g, "").toUpperCase();
  }

  function isAvailableSeat(button) {
    return button.classList.contains(SELECTORS.seats.available)
      && !button.disabled
      && !button.classList.contains(SELECTORS.seats.booked)
      && !button.classList.contains(SELECTORS.seats.disabled)
      && !button.classList.contains(SELECTORS.seats.hidden)
      && !button.classList.contains(SELECTORS.seats.inProgress)
      && seatIdentity(button);
  }

  function readSeatGrid() {
    const buttons = [...document.querySelectorAll(`${SELECTORS.seats.layout} ${SELECTORS.seats.seatButton}`)];
    const seats = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        button,
        label: seatIdentity(button),
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        available: isAvailableSeat(button),
        selected: button.classList.contains(SELECTORS.seats.selected)
      };
    }).filter((seat) => seat.label && seat.width >= 2 && seat.height >= 2);

    seats.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const seat of seats) {
      const row = rows.find((item) => Math.abs(item.y - seat.y) <= 14);
      if (row) row.seats.push(seat);
      else rows.push({ y: seat.y, seats: [seat] });
    }
    rows.sort((a, b) => a.y - b.y);
    rows.forEach((row, rowIndex) => {
      row.seats.sort((a, b) => a.x - b.x);
      let splitAt = -1;
      if (row.seats.length >= 3) {
        let maxGap = 0;
        let typical = 0;
        for (let index = 0; index < row.seats.length - 1; index += 1) {
          const gap = row.seats[index + 1].x - row.seats[index].x;
          typical += gap;
          if (gap > maxGap) {
            maxGap = gap;
            splitAt = index;
          }
        }
        typical /= Math.max(1, row.seats.length - 1);
        if (!(maxGap > typical * 1.6)) splitAt = -1;
      }
      row.seats.forEach((seat, col) => {
        seat.row = rowIndex;
        seat.col = col;
        if (splitAt < 0) seat.side = "center";
        else seat.side = col <= splitAt ? "left" : "right";
      });
    });
    return seats;
  }

  function adjacentPair(list) {
    if (!list || list.length < 2) return null;
    const ordered = [...list].sort((a, b) => a.col - b.col);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      if (ordered[index + 1].col - ordered[index].col === 1) {
        return [ordered[index], ordered[index + 1]];
      }
    }
    return null;
  }

  function chooseSeats(seats, quantity, preferredLabels, allowSeatFallback) {
    const chosen = [];
    const used = new Set(seats.filter((seat) => seat.selected).map((seat) => seat.label));
    seats.filter((seat) => seat.selected).forEach((seat) => chosen.push(seat));

    for (const wanted of preferredLabels) {
      if (chosen.length >= quantity) break;
      const key = wanted.replace(/\s+/g, "").toUpperCase();
      const seat = seats.find((item) => item.available && !used.has(item.label) && item.label === key);
      if (seat) {
        chosen.push(seat);
        used.add(seat.label);
      }
    }

    if (preferredLabels.length > 0 && !allowSeatFallback) {
      return chosen.filter((seat) => !seat.selected).slice(0, Math.max(0, quantity - seats.filter((seat) => seat.selected).length));
    }

    const available = () => seats.filter((seat) => seat.available && !used.has(seat.label));
    const add = (seat) => {
      if (!seat || used.has(seat.label) || chosen.length >= quantity) return;
      chosen.push(seat);
      used.add(seat.label);
    };

    if (chosen.length < quantity) {
      const pool = available();
      const rows = [...new Set(pool.map((seat) => seat.row))].sort((a, b) => a - b);
      const grouped = new Map();
      pool.forEach((seat) => {
        const key = `${seat.row}:${seat.side}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(seat);
      });
      const sides = ["right", "left", "center"];
      let block = null;
      if (quantity >= 4) {
        for (const side of sides) {
          for (let index = 0; index < rows.length - 1 && !block; index += 1) {
            const top = adjacentPair(grouped.get(`${rows[index]}:${side}`));
            const below = adjacentPair(grouped.get(`${rows[index + 1]}:${side}`));
            if (top && below) block = [...top, ...below];
          }
        }
      }
      if (!block && quantity >= 2) {
        for (const side of sides) {
          for (const row of rows) {
            const pair = adjacentPair(grouped.get(`${row}:${side}`));
            if (!pair) continue;
            const below = adjacentPair(grouped.get(`${row + 1}:${side}`)) || [];
            const group = [...pair, ...below];
            if (group.length >= quantity - chosen.length || quantity - chosen.length <= 2) {
              block = group;
              break;
            }
          }
          if (block) break;
        }
      }
      (block || []).forEach(add);
    }

    if (chosen.length < quantity) {
      const anchor = chosen.find((seat) => seat.row !== undefined) || available().sort((a, b) => a.row - b.row || a.col - b.col)[0];
      const rest = available().sort((a, b) => {
        const left = anchor ? ((a.row - anchor.row) ** 2) + ((a.col - anchor.col) ** 2) : a.row;
        const right = anchor ? ((b.row - anchor.row) ** 2) + ((b.col - anchor.col) ** 2) : b.row;
        return left - right || a.row - b.row || a.col - b.col;
      });
      rest.forEach(add);
    }

    return chosen.filter((seat) => !seat.selected).slice(0, Math.max(0, quantity - seats.filter((seat) => seat.selected).length));
  }

  function coachOptions() {
    return [...document.querySelectorAll(SELECTORS.seats.coachOption)].filter((option) => option.value !== "");
  }

  function coachSeatCount(option) {
    const match = textOf(option).match(/(\d+)\s*seat/i);
    return match ? Number(match[1]) : null;
  }

  function coachCode(option) {
    return textOf(option).split(/\s+-\s+/)[0].trim().toUpperCase();
  }

  async function selectCoach(config, skipped, allowFallback) {
    const select = document.querySelector(SELECTORS.seats.coachSelect);
    if (!select) throw new Error("Coach dropdown is missing.");
    const options = coachOptions().filter((option) => !skipped.has(option.value));
    if (!options.length) return null;
    const preferred = (config.preferredCoach || "").trim().toUpperCase();
    let option = null;
    if (preferred) {
      const match = options.find((item) => coachCode(item) === preferred);
      if (match && coachSeatCount(match) !== 0) option = match;
    }
    const fellBack = !option && Boolean(preferred);
    if (!option && (allowFallback || !preferred)) {
      option = options.find((item) => {
        const count = coachSeatCount(item);
        const extra = /xtr/i.test(textOf(item));
        return !extra && count !== 0;
      }) || options.find((item) => coachSeatCount(item) !== 0);
    }
    if (!option) return null;
    skipped.add(option.value);
    setNativeValue(select, option.value);
    await saveTicket({ coach: coachCode(option) });
    if (fellBack) await log(`Coach ${preferred} is full. Fallback coach ${textOf(option)}.`);
    else await log(`Coach set to ${textOf(option)}.`);
    await delay(250);
    if (await dismissSafeDialog()) return null;
    await waitFor(() => document.querySelector(`${SELECTORS.seats.layout} ${SELECTORS.seats.seatButton}`), 8000);
    await delay(250);
    return option;
  }

  async function clickSeat(seat) {
    seat.button.click();
    const selected = await waitFor(() => {
      if (seat.button.classList.contains(SELECTORS.seats.selected)) return seat.button;
      if (seat.button.classList.contains(SELECTORS.seats.pending)) return null;
      return null;
    }, 5000, 100);
    if (selected) return true;
    const stopped = await dismissSafeDialog();
    if (stopped) return false;
    return seat.button.classList.contains(SELECTORS.seats.selected);
  }

  function continueButton() {
    const nodes = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit']")];
    const byText = nodes.find((el) => /continue\s*purchase/i.test((el.innerText || el.value || "").replace(/\s+/g, " ")));
    const button = byText || document.querySelector(SELECTORS.seats.continueButton);
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return null;
    const style = getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return null;
    return button;
  }

  async function runSeatSelect(config) {
    const quantity = Number(config.seatQuantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) {
      await fail("SEAT_SELECT", "seatQuantity", "Seat quantity must be 1–4.");
      return;
    }
    const preferred = (config.preferredSeats || "").split(",").map((item) => item.trim()).filter(Boolean);
    const skipped = new Set();
    let coach = await selectCoach(config, skipped, config.allowCoachFallback === true);
    if (!coach) {
      const preferredCoach = (config.preferredCoach || "").trim();
      const detail = preferredCoach && config.allowCoachFallback !== true
        ? `Coach ${preferredCoach} has no seats. Tick "Any coach if this one is full" to use another coach.`
        : "No coach with seats was available.";
      await fail("SEAT_SELECT", SELECTORS.seats.coachSelect, detail);
      return;
    }

    for (let coachTry = 0; coachTry < 8 && coach; coachTry += 1) {
      const gridReady = await waitFor(() => {
        const seats = readSeatGrid();
        return seats.length ? seats : null;
      }, 8000);
      if (!gridReady) {
        await fail("SEAT_SELECT", SELECTORS.seats.seatButton, "Seat buttons did not render.");
        return;
      }

      let seats = readSeatGrid();
      const picks = chooseSeats(seats, quantity, preferred, config.allowSeatFallback === true);
      await log(`Choosing ${picks.map((seat) => seat.label).join(", ") || "no seats"} in this coach.`);
      for (const seat of picks) {
        seats = readSeatGrid();
        const fresh = seats.find((item) => item.label === seat.label);
        if (!fresh?.available) continue;
        const ok = await clickSeat(fresh);
        if ((await getState()).phase === "ERROR" || (await getState()).phase === "STOPPED_AT_OTP" || (await getState()).phase === "STOPPED_AT_CONTINUE") return;
        if (!ok) await log(`Seat ${fresh.label} could not be selected.`, "error");
      }

      const selectedCount = readSeatGrid().filter((seat) => seat.selected).length;
      if (selectedCount >= quantity) break;
      if (config.allowCoachFallback !== true) {
        const seatHint = preferred.length && config.allowSeatFallback !== true
          ? ` Preferred seats are not available. Tick "Any seats if the ones above are taken" to pick other seats.`
          : "";
        await fail("SEAT_SELECT", SELECTORS.seats.seatButton, `Only ${selectedCount} of ${quantity} seats could be selected.${seatHint}`);
        return;
      }
      await log(`Coach has ${selectedCount}/${quantity} seats. Trying another coach.`);
      coach = await selectCoach({ ...config, preferredCoach: "" }, skipped, true);
      if (!coach) {
        await fail("SEAT_SELECT", SELECTORS.seats.coachSelect, `Only ${selectedCount} of ${quantity} seats could be selected.`);
        return;
      }
    }

    const finalCount = readSeatGrid().filter((seat) => seat.selected).length;
    if (finalCount < quantity) {
      await fail("SEAT_SELECT", SELECTORS.seats.seatButton, `Selected ${finalCount} of ${quantity} seats.`);
      return;
    }

    const selectedSeats = readSeatGrid().filter((seat) => seat.selected).map((seat) => seat.label);
    const wantedCoach = (config.preferredCoach || "").trim().toUpperCase();
    const gotCoach = coachCode(coach);
    if (wantedCoach && gotCoach && gotCoach !== wantedCoach) {
      await addFallbackNote(`Coach ${wantedCoach} was full. Booked ${gotCoach}.`);
    }
    const wantedSeats = preferred.map((item) => item.replace(/\s+/g, "").toUpperCase());
    const missingSeats = wantedSeats.filter((label) => !selectedSeats.includes(label));
    if (missingSeats.length) {
      await addFallbackNote(`Seats ${missingSeats.join(", ")} were taken. Booked ${selectedSeats.join(", ")}.`);
    }
    await saveTicket({
      coach: gotCoach || "",
      seats: selectedSeats
    });
    if (config.continueToOtp !== true) {
      await stopBeforeContinue();
      return;
    }
    await log("Seats selected. Waiting for Continue Purchase.");
    const button = await waitFor(continueButton, 8000, 150);
    if (!button) {
      await fail("SEAT_SELECT", SELECTORS.seats.continueButton, "Continue Purchase is missing or disabled.");
      return;
    }
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await setState({ phase: "CONTINUE_CLICKED" });
    await log("Clicking Continue Purchase.");
    button.click();
    armOtpWatch();
  }

  async function runContinue() {
    if (isOtpScreen()) {
      await stopAtOtp();
      return;
    }
    if (SELECTORS.payment.path.test(location.pathname)) {
      await fail("CONTINUE_CLICKED", location.pathname, "Payment page detected. Automation stopped without paying.");
      return;
    }
    await log("Continue Purchase completed. Not filling passenger details, OTP, or payment. Watching for the OTP screen.");
    armOtpWatch();
  }

  async function route(reason) {
    if (busy) {
      rerun = true;
      return;
    }
    busy = true;
    try {
      const state = await getState();
      const phase = state.phase || "IDLE";
      if (TERMINAL.has(phase)) return;
      if (isOtpScreen() && phase !== "IDLE") {
        await stopAtOtp();
        return;
      }
      const config = await getConfig();
      if (!config) {
        await fail(phase, CONFIG_KEY, "No saved config.");
        return;
      }
      if (phase === "ARMED") return;
      if (phase === "SEARCHING") await runSearching(config, state);
      else if (phase === "RESULTS") await runResults(config);
      else if (phase === "SEAT_SELECT") {
        const layout = await waitForSelector(SELECTORS.seats.layout, 8000);
        if (unloaded) return;
        if (!layout) {
          await fail("SEAT_SELECT", SELECTORS.seats.layout, "Seat map was not on the page.");
          return;
        }
        await runSeatSelect(config);
      } else if (phase === "CONTINUE_CLICKED") await runContinue();
    } catch (error) {
      await fail(reason || "route", "", error);
    } finally {
      busy = false;
      if (rerun && !unloaded) {
        rerun = false;
        route(reason);
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "START_SEARCH") return false;
    getState()
      .then(async (state) => {
        const phase = state.phase || "IDLE";
        if (phase === "ERROR" || phase === "STOPPED_AT_OTP" || phase === "STOPPED_AT_CONTINUE") {
          sendResponse({ ok: false, error: `Automation is ${phase}.` });
          return;
        }
        if (phase === "ARMED" || phase === "IDLE") {
          await setState({ phase: "SEARCHING", formFallbackTried: false, activeClass: "", triedClasses: [] });
        }
        sendResponse({ ok: true });
        if (phase === "ARMED" || phase === "IDLE" || phase === "SEARCHING") route("START_SEARCH");
      })
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  armOtpWatch();
  route("load");
})();
