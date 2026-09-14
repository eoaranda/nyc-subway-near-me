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
  parseFeed,
  stationView, formatCountdown, disambiguate, isCatchable,
  feedsForRoutes, feedUrl, routeStyle, routeColor, baseRoute, isExpress,
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
    if (result.status === "fulfilled") arrivals.push(...result.value[1]);
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

function departureRow(departure, walk) {
  const row = document.createElement("div");
  row.className = "departure";

  const heading = document.createElement("span");
  heading.className = "heading";
  heading.textContent = departure.heading;
  row.append(bullet(departure.route), heading);

  // Always three cells, so a station with one train keeps the columns
  // of the station above it.
  for (let slot = 0; slot < 3; slot += 1) {
    const cell = document.createElement("span");
    cell.className = "t";
    const minutes = departure.minutes[slot];
    if (minutes !== undefined) {
      cell.textContent = formatCountdown(minutes);
      if (isCatchable(minutes, walk)) cell.classList.add("catchable");
    }
    row.append(cell);
  }
  return row;
}

function stationCard(view) {
  const card = document.createElement("section");
  card.className = "station";

  const head = document.createElement("header");
  const name = document.createElement("h2");
  name.textContent = view.name;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = "· " + view.miles.toFixed(2) + " mi · "
    + Math.max(1, Math.round(view.walk)) + " min walk";
  head.append(name, meta);
  card.append(head);

  if (!view.departures.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "no trains reported";
    card.append(empty);
  } else {
    for (const departure of view.departures) {
      card.append(departureRow(departure, view.walk));
    }
  }
  return card;
}

function render() {
  const now = Date.now() / 1000;
  const board = document.createDocumentFragment();
  const views = disambiguate(state.nearby.map(
    (place) => stationView(place, state.arrivals, now)));
  for (const view of views) board.append(stationCard(view));
  $board.replaceChildren(board);

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
