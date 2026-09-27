/**
 * Rail Auto-Booker page driver.
 *
 * Hard stop: this file never reads, writes, or submits an OTP field,
 * never reads SMS or the clipboard, and never clicks Verify or payment.
 */
(() => {
  if (window !== window.top) return;

  const STATE_KEY = "railBookerState";
  const CONFIG_KEY = "railBookerConfig";
  const LOG_KEY = "railBookerLogs";
  const LOG_LIMIT = 50;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const TERMINAL = new Set(["IDLE", "STOPPED_AT_OTP", "ERROR"]);

  let busy = false;
  let rerun = false;
  let unloaded = false;
  let otpWatcher = null;

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
    if (state.phase === "ERROR" || state.phase === "STOPPED_AT_OTP") return;
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
    if (document.querySelector(SELECTORS.otp.container)) return true;
    const headings = [...document.querySelectorAll(SELECTORS.otp.heading)].map(textOf).join(" ");
    return /enter your otp code/i.test(headings) && /verif/i.test(headings);
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

  async function stopAtOtp() {
    if (otpWatcher) {
      otpWatcher.disconnect();
      otpWatcher = null;
    }
    const state = await getState();
    if (state.phase === "STOPPED_AT_OTP") return;
    await log("Reached OTP screen — stopping automation, please enter the code manually.");
    await setState({
      phase: "STOPPED_AT_OTP",
      lastError: null
    });
  }

  function watchForOtp(timeout = 120000) {
    if (otpWatcher) otpWatcher.disconnect();
    otpWatcher = new MutationObserver(() => {
      if (isOtpScreen()) stopAtOtp();
      else if (SELECTORS.payment.path.test(location.pathname)) {
        fail("CONTINUE_CLICKED", "payment-url", "Payment page detected. Automation stopped without paying.");
      }
    });
    otpWatcher.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      if (otpWatcher) {
        otpWatcher.disconnect();
        otpWatcher = null;
      }
    }, timeout);
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
      await setState({ phase: "RESULTS" });
      await runResults(config);
      return;
    }
    if (state.formFallbackTried) {
      await fillSearchForm(config);
      return;
    }
    const url = buildSearchUrl(config);
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
    const visible = textOf(card).toLowerCase();
    if (visible.includes(needle)) return true;
    const trip = tripRecord(card);
    if (!trip) return false;
    const blob = `${trip.trip_number || ""} ${trip.train_model || ""}`.toLowerCase();
    return blob.includes(needle);
  }

  function classColumn(card, trainClass) {
    const columns = [...card.querySelectorAll(SELECTORS.results.classColumn)];
    return columns.find((column) => textOf(column.querySelector(SELECTORS.results.className)).toUpperCase() === trainClass.toUpperCase()) || null;
  }

  function availableCount(column) {
    const nodes = [...column.querySelectorAll(SELECTORS.results.availableCount)];
    for (const node of nodes) {
      const raw = textOf(node);
      if (/^\d+$/.test(raw)) return Number(raw);
    }
    return null;
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

    const card = [...document.querySelectorAll(SELECTORS.results.trainList)].find((item) => cardMatches(item, needle));
    if (!card) {
      await fail("RESULTS", SELECTORS.results.trainName, `No train matched "${config.targetTrain}".`);
      return;
    }

    const column = classColumn(card, config.trainClass);
    if (!column) {
      await fail("RESULTS", SELECTORS.results.className, `Class ${config.trainClass} is not on that train card.`);
      return;
    }

    const count = availableCount(column);
    const book = column.querySelector(SELECTORS.results.bookNow);
    if (!book || book.disabled || column.querySelector(SELECTORS.results.unavailableWrap) || count === 0) {
      await fail("RESULTS", SELECTORS.results.bookNow, `No online seats for ${config.trainClass}${count === null ? "" : ` (count ${count})`}.`);
      return;
    }

    await log(`Booking ${config.targetTrain} / ${config.trainClass}${count === null ? "" : ` (${count} shown)`}.`);
    await setState({ phase: "SEAT_SELECT" });
    book.click();
    const layout = await waitForSelector(SELECTORS.seats.layout, 8000);
    if (!layout) {
      await fail("SEAT_SELECT", SELECTORS.seats.layout, "Seat map did not open within 8s.");
      return;
    }
    await runSeatSelect(config);
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

  function chooseSeats(seats, quantity, preferredLabels) {
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

  async function selectCoach(config, skipped) {
    const select = document.querySelector(SELECTORS.seats.coachSelect);
    if (!select) throw new Error("Coach dropdown is missing.");
    const options = coachOptions().filter((option) => !skipped.has(option.value));
    if (!options.length) return null;
    const preferred = (config.preferredCoach || "").trim().toUpperCase();
    let option = null;
    if (preferred && !skipped.has(`pref:${preferred}`)) {
      option = options.find((item) => coachCode(item) === preferred || textOf(item).toUpperCase().startsWith(preferred));
      skipped.add(`pref:${preferred}`);
    }
    if (!option) {
      option = options.find((item) => {
        const count = coachSeatCount(item);
        const extra = /xtr/i.test(textOf(item));
        return !extra && count !== 0 && !skipped.has(optionValue(item));
      }) || options.find((item) => coachSeatCount(item) !== 0);
    }
    if (!option) return null;
    skipped.add(option.value);
    setNativeValue(select, option.value);
    await log(`Coach set to ${textOf(option)}.`);
    await delay(250);
    if (await dismissSafeDialog()) return null;
    await waitFor(() => document.querySelector(`${SELECTORS.seats.layout} ${SELECTORS.seats.seatButton}`), 8000);
    await delay(250);
    return option;
  }

  function optionValue(option) {
    return option.value;
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

  async function ensureBoarding(config) {
    const select = document.querySelector(SELECTORS.seats.boardingSelect);
    if (!select) throw new Error("Boarding station dropdown is missing.");
    const wanted = (config.boardingStation || config.fromStation || "").trim().toLowerCase();
    const options = [...select.options].filter((option) => option.value);
    if (wanted) {
      const match = options.find((option) => textOf(option).toLowerCase().includes(wanted));
      if (!match) throw new Error(`Boarding station "${config.boardingStation || config.fromStation}" is not in the list.`);
      if (select.value !== match.value) setNativeValue(select, match.value);
      await log(`Boarding station: ${textOf(match)}.`);
      return;
    }
    if (!select.value && options[0]) {
      setNativeValue(select, options[0].value);
      await log(`Boarding station left on the site default: ${textOf(options[0])}.`);
    }
  }

  async function runSeatSelect(config) {
    const quantity = Number(config.seatQuantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) {
      await fail("SEAT_SELECT", "seatQuantity", "Seat quantity must be 1–4.");
      return;
    }
    const preferred = (config.preferredSeats || "").split(",").map((item) => item.trim()).filter(Boolean);
    const skipped = new Set();
    let coach = await selectCoach(config, skipped);
    if (!coach) {
      await fail("SEAT_SELECT", SELECTORS.seats.coachSelect, "No coach with seats was available.");
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
      const picks = chooseSeats(seats, quantity, preferred);
      await log(`Choosing ${picks.map((seat) => seat.label).join(", ") || "no seats"} in this coach.`);
      for (const seat of picks) {
        seats = readSeatGrid();
        const fresh = seats.find((item) => item.label === seat.label);
        if (!fresh?.available) continue;
        const ok = await clickSeat(fresh);
        if ((await getState()).phase === "ERROR" || (await getState()).phase === "STOPPED_AT_OTP") return;
        if (!ok) await log(`Seat ${fresh.label} could not be selected.`, "error");
      }

      const selectedCount = readSeatGrid().filter((seat) => seat.selected).length;
      if (selectedCount >= quantity) break;
      if (!config.allowCoachFallback) {
        await fail("SEAT_SELECT", SELECTORS.seats.seatButton, `Only ${selectedCount} of ${quantity} seats could be selected.`);
        return;
      }
      await log(`Coach has ${selectedCount}/${quantity} seats. Trying another coach.`);
      coach = await selectCoach({ ...config, preferredCoach: "" }, skipped);
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

    await ensureBoarding(config);
    const button = document.querySelector(SELECTORS.seats.continueButton);
    if (!button || button.disabled) {
      await fail("SEAT_SELECT", SELECTORS.seats.continueButton, "Continue Purchase is missing or disabled.");
      return;
    }
    await setState({ phase: "CONTINUE_CLICKED" });
    await log("Clicking Continue Purchase.");
    button.click();
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
    const appeared = await waitFor(() => (isOtpScreen() ? true : null), 15000, 200);
    if (appeared) {
      await stopAtOtp();
      return;
    }
    if ((await getState()).phase === "ERROR") return;
    await log("OTP screen is not visible yet. Automation will stop if it appears, and will not type a code.");
    watchForOtp();
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
        if (phase === "ERROR" || phase === "STOPPED_AT_OTP") {
          sendResponse({ ok: false, error: `Automation is ${phase}.` });
          return;
        }
        if (phase === "ARMED" || phase === "IDLE") {
          await setState({ phase: "SEARCHING", formFallbackTried: false });
        }
        sendResponse({ ok: true });
        if (phase === "ARMED" || phase === "IDLE" || phase === "SEARCHING") route("START_SEARCH");
      })
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  route("load");
})();
