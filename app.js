/* subway, on the web.
 *
 * The impure shell: geolocation, network, DOM. Every decision worth
 * testing lives in core.js, which is why this file has no arithmetic in
 * it beyond formatting.
 *
 * Nothing is sent anywhere. Your coordinates stay in this tab -- the
 * only requests made are to the MTA's public feeds, which are fetched
 * whole and filtered here.
 */
import {
  nearest, parseStations,
  parseFeed, arrivalsOf, stopNames, stopName, minutesUntil,
  stationView, formatCountdown, disambiguate, isCatchable,
  feedsForRoutes, feedUrl, routeStyle, routeColor, baseRoute, isExpress,
  groupByRoute,
} from "./core.js";

const REFETCH_MS = 30_000;   // the feeds themselves update about this often
const TICK_MS = 1_000;       // countdowns are recomputed locally, for free

const params = new URLSearchParams(location.search);
const count = Math.min(Math.max(parseInt(params.get("n"), 10) || 3, 1), 8);
const fixed = params.get("lat") && params.get("lon")
  ? { lat: parseFloat(params.get("lat")), lon: parseFloat(params.get("lon")) }
  : null;

const $board = document.getElementById("board");
const $status = document.getElementById("status");
const $ask = document.getElementById("ask");

const state = {
  stations: null,   // the 496-row table
  nearby: [],       // complexes around us
  arrivals: [],     // every train touching them
  fetchedAt: null,
  error: null,
  openLines: new Set(),  // lines showing every direction, not just two
  openRows: new Set(),   // services showing their remaining stops
  names: null,           // stop ID -> station name
};


function setStatus(text, bad) {
  $status.textContent = text;
  if (bad) $status.dataset.state = "bad";
  else delete $status.dataset.state;
}

/* ------------------------------------------------------------------ data */

async function loadStations() {
  const response = await fetch("./stations.json");
  if (!response.ok) throw new Error("station list unavailable");
  return parseStations(await response.json());
}

function locate() {
  if (fixed) return Promise.resolve(fixed);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("this browser has no location support"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude,
                              lon: position.coords.longitude }),
      (problem) => reject(new Error(
        problem.code === problem.PERMISSION_DENIED
          ? "location permission denied"
          : "could not get your location")),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 });
  });
}

/* Fetch every feed our shortlist needs, in parallel.
 *
 * Only the feeds carrying nearby lines are fetched -- typically three
 * of the eight, which is the difference between half a megabyte and a
 * megabyte and a half on a phone.
 */
async function refresh() {
  const routes = state.nearby.flatMap((place) =>
    place.stations.flatMap((station) => station.routes));
  const names = feedsForRoutes(routes);
  if (!names.length) return;

  const results = await Promise.allSettled(names.map(async (name) => {
    const response = await fetch(feedUrl(name), { cache: "no-store" });
    if (!response.ok) throw new Error(name + ": HTTP " + response.status);
    return parseFeed(new Uint8Array(await response.arrayBuffer()));
  }));

  const arrivals = [];
  let failures = 0;
  for (const result of results) {
    if (result.status === "fulfilled") arrivals.push(...arrivalsOf(result.value[1]));
    else failures += 1;
  }

  if (failures === names.length) {
    state.error = "feeds unreachable";
  } else {
    state.arrivals = arrivals;
    state.fetchedAt = Date.now();
    state.error = failures ? failures + " of " + names.length + " feeds failed" : null;
  }
  render();
}

/* ----------------------------------------------------------------- views */

function bullet(route) {
  const node = document.createElement("span");
  node.className = "bullet on-" + routeStyle(route)
    + (isExpress(route) ? " express" : "");
  node.style.background = routeColor(route);
  const label = document.createElement("span");
  label.textContent = baseRoute(route);   // the X is the diamond, not a letter
  node.append(label);
  return node;
}

/* What a station will actually draw.
 *
 * Every line the station serves is listed. Within a line only the two
 * soonest directions show, unless the reader has unfolded it -- which
 * is rare, because a line usually runs in exactly two directions.
 */
function planStation(view) {
  const shown = groupByRoute(view.departures).map((group) => {
    const open = state.openLines.has(view.name + "|" + group.route);
    return { ...group, open, rows: open ? group.all : group.departures };
  });
  return { view, shown };
}

/* The structure of the board, with the countdowns deliberately left
 * out -- those change constantly and must not force a rebuild.
 */
function shapeOf(plans) {
  return JSON.stringify(plans.map((plan) => [
    plan.view.name,
    plan.shown.map((group) => [group.route, group.open,
                               group.rows.map((d) => d.heading)]),
    [...state.openRows].sort(),
  ]));
}

// Every countdown cell on screen, in the order the board draws them.
let cells = [];
let stopCells = [];
let shape = null;

const rowKey = (stationName, departure) =>
  stationName + "|" + departure.route + "|" + departure.heading;

function stopList(departure) {
  const box = document.createElement("div");
  box.className = "ahead";

  const caption = document.createElement("p");
  caption.className = "caption";
  caption.textContent = "This " + baseRoute(departure.route)
    + " train stops at, arriving in:";
  box.append(caption);

  const list = document.createElement("ol");
  list.className = "stops";
  if (!departure.ahead.length) {
    const item = document.createElement("li");
    item.className = "quiet";
    item.textContent = "last stop on this train";
    list.append(item);
    box.append(list);
    return box;
  }
  for (const stop of departure.ahead) {
    const item = document.createElement("li");
    const where = document.createElement("span");
    where.textContent = stopName(state.names, stop.stopId);
    const when = document.createElement("span");
    when.className = "at";
    stopCells.push({ span: when, at: stop.when });
    item.append(where, when);
    list.append(item);
  }
  box.append(list);
  return box;
}

function departureRow(departure, walk, stationName) {
  const wrap = document.createElement("div");
  wrap.className = "line";

  const row = document.createElement("button");
  row.type = "button";
  row.className = "departure";

  const mark = bullet(departure.route);

  const heading = document.createElement("span");
  heading.className = "heading";
  heading.textContent = departure.heading;
  row.append(mark, heading);

  const spans = [];
  for (let slot = 0; slot < 3; slot += 1) {
    const cell = document.createElement("span");
    cell.className = "t";
    spans.push(cell);
    row.append(cell);
  }
  cells.push({ spans, walk });

  const key = rowKey(stationName, departure);
  const open = state.openRows.has(key);
  const chevron = document.createElement("span");
  chevron.className = "chev" + (open ? " open" : "");
  chevron.textContent = "\u203a";
  row.append(chevron);
  row.setAttribute("aria-expanded", open ? "true" : "false");

  row.addEventListener("click", () => {
    if (open) state.openRows.delete(key);
    else state.openRows.add(key);
    render();
  });

  wrap.append(row);
  if (open) wrap.append(stopList(departure));
  return wrap;
}

function stationCard(plan) {
  const { view } = plan;
  const card = document.createElement("section");
  card.className = "station";

  const head = document.createElement("header");
  const name = document.createElement("h2");
  name.textContent = view.name;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = "\u00b7 " + view.miles.toFixed(2) + " mi \u00b7 "
    + Math.max(1, Math.round(view.walk)) + " min walk";
  head.append(name, meta);
  card.append(head);

  if (!view.departures.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "no trains reported";
    card.append(empty);
    return card;
  }

  for (const group of plan.shown) {
    const band = document.createElement("div");
    band.className = "group";
    for (const departure of group.rows) {
      band.append(departureRow(departure, view.walk, view.name));
    }

    // Rare: a line running more than two ways out of one complex.
    if (group.hidden > 0 || group.open) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "more";
      more.textContent = group.open
        ? "Show fewer"
        : group.hidden + " more "
          + (group.hidden === 1 ? "direction" : "directions");
      more.addEventListener("click", () => {
        const key = view.name + "|" + group.route;
        if (group.open) state.openLines.delete(key);
        else state.openLines.add(key);
        render();
      });
      band.append(more);
    }
    card.append(band);
  }
  return card;
}

/* Write the countdowns into cells that already exist.
 *
 * This walks the plan in exactly the order the board was built, so
 * cell N always belongs to the same service it did a second ago.
 */
function paintTimes(plans, now) {
  for (const { span, at } of stopCells) {
    const text = formatCountdown(minutesUntil(at, now));
    if (span.textContent !== text) span.textContent = text;
  }
  let at = 0;
  for (const plan of plans) {
    for (const group of plan.shown) {
      for (const departure of group.rows) {
        const { spans, walk } = cells[at];
        at += 1;
        spans.forEach((cell, slot) => {
          const minutes = departure.minutes[slot];
          const text = minutes === undefined ? "" : formatCountdown(minutes);
          if (cell.textContent !== text) cell.textContent = text;
          cell.classList.toggle("catchable",
            minutes !== undefined && isCatchable(minutes, walk));
        });
      }
    }
  }
}

/* Redraw.
 *
 * The countdowns are recomputed every second, but at a station like
 * Union Sq some number among fifty ticks over almost every second --
 * so rebuilding the board on any change would rebuild it constantly,
 * losing scroll position and swallowing taps. Only a change in the
 * board's *shape* rebuilds; otherwise the existing cells are repainted.
 */
function render() {
  const now = Date.now() / 1000;
  const plans = disambiguate(state.nearby.map(
    (place) => stationView(place, state.arrivals, now))).map(planStation);

  const next = shapeOf(plans);
  if (next !== shape) {
    shape = next;
    cells = [];
    stopCells = [];
    const board = document.createDocumentFragment();
    for (const plan of plans) board.append(stationCard(plan));
    $board.replaceChildren(board);
  }
  paintTimes(plans, now);

  if (state.error) {
    setStatus(state.error, true);
  } else if (state.fetchedAt) {
    const age = Math.round((Date.now() - state.fetchedAt) / 1000);
    setStatus(age < 5 ? "just now" : age + "s ago");
  }
}

/* ------------------------------------------------------------------ main */

async function start() {
  $ask.hidden = true;
  try {
    setStatus("locating");
    const [stations, where] = await Promise.all([
      state.stations ? Promise.resolve(state.stations) : loadStations(),
      locate(),
    ]);
    state.stations = stations;
    state.names = stopNames(stations);
    state.nearby = nearest(stations, where.lat, where.lon, count);
    render();
    setStatus("loading trains");
    await refresh();
  } catch (problem) {
    setStatus(problem.message, true);
    $ask.hidden = false;
    return;
  }

  setInterval(render, TICK_MS);
  setInterval(() => { if (!document.hidden) refresh(); }, REFETCH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}

document.getElementById("locate").addEventListener("click", start);

/* Ask straight away only when permission is already settled: a cold
 * prompt on load reads as a page grabbing at something, and iOS wants
 * a gesture anyway.
 */
(async () => {
  if (fixed) { start(); return; }
  let granted = false;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    granted = status.state === "granted";
  } catch (problem) { granted = false; }
  if (granted) start();
  else { setStatus("ready"); $ask.hidden = false; }
})();
