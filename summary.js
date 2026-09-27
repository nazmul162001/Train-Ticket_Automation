const TICKET_KEY = "railBookerTicket";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CLASS_NAMES = {
  AC_B: "AC Berth",
  AC_S: "AC Seat",
  SNIGDHA: "Snigdha",
  F_BERTH: "First Berth",
  F_SEAT: "First Seat",
  F_CHAIR: "First Chair",
  S_CHAIR: "Shovon Chair",
  SHOVAN: "Shovon",
  SHULOV: "Shulov",
  AC_CHAIR: "AC Chair"
};

function text(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || "—";
}

function clockLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{1,2}\s+[A-Za-z]{3},?\s+\d{1,2}:\d{2}/.test(raw)) return raw;
  const parsed = new Date(/^\d{4}[-/]/.test(raw) ? raw.replace(/-/g, "/") : raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const day = String(parsed.getDate()).padStart(2, "0");
  const month = MONTHS[parsed.getMonth()].toUpperCase();
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  const suffix = parsed.getHours() >= 12 ? "PM" : "AM";
  const hour = parsed.getHours() % 12 || 12;
  return `${day} ${month}, ${String(hour).padStart(2, "0")}:${minute} ${suffix}`;
}

function durationLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/h/i.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return raw;
  return `${match[1].padStart(2, "0")}h ${match[2]}m`;
}

function trainLabel(ticket) {
  const name = ticket.trainName || "";
  const number = ticket.trainNumber || "";
  if (!name) return number ? `Train ${number}` : "";
  if (!number || name.includes(String(number))) return name;
  return `${name} (${number})`;
}

function classLabel(value) {
  if (!value) return "";
  const name = CLASS_NAMES[value];
  return name ? `${value} — ${name}` : value;
}

function render(ticket) {
  const data = ticket || {};
  text("from", data.from);
  text("to", data.to);
  const note = document.querySelector(".note");
  if (note) {
    note.textContent = data.manualContinue
      ? "Seats are selected. Click Continue Purchase on the railway page yourself. This window does not click that button."
      : "After you type the OTP on the railway page, this is the ticket that confirms. This window does not read or send the code.";
  }
  text("depart", clockLabel(data.depart));
  text("arrive", clockLabel(data.arrive));
  text("travel", durationLabel(data.travelTime));
  const banner = document.getElementById("mismatch");
  if (data.mismatch) {
    banner.hidden = false;
    banner.textContent = `Do not enter the OTP. This page is ${trainLabel(data) || "a different train"}, not ${data.requestedTrain}.`;
  } else {
    banner.hidden = true;
    banner.textContent = "";
  }
  const fallback = document.getElementById("fallback-note");
  if (fallback) {
    fallback.hidden = !data.fallbackNote;
    fallback.textContent = data.fallbackNote || "";
  }
  text("train", trainLabel(data));
  text("train-class", classLabel(data.trainClass));
  text("coach", data.coach);
  const seats = document.getElementById("seats");
  const list = Array.isArray(data.seats) ? data.seats : String(data.seats || "").split(",").map((item) => item.trim()).filter(Boolean);
  seats.replaceChildren();
  if (!list.length) {
    seats.textContent = "—";
  } else {
    list.forEach((seat) => {
      const chip = document.createElement("span");
      chip.textContent = seat;
      seats.appendChild(chip);
    });
  }
  const fareRow = document.getElementById("fare-row");
  if (data.fare) {
    fareRow.hidden = false;
    text("fare", `${data.currency || "৳"} ${data.fare}`);
  } else {
    fareRow.hidden = true;
  }
}

async function load() {
  if (!globalThis.chrome?.storage?.local) return;
  const stored = await chrome.storage.local.get(TICKET_KEY);
  render(stored[TICKET_KEY]);
}

document.addEventListener("DOMContentLoaded", load);
if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[TICKET_KEY]) render(changes[TICKET_KEY].newValue);
  });
}
