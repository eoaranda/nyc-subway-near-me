/* subway: everything worth testing.
 *
 * Pure logic, ported from the Python tool one directory up. No DOM, no
 * network, no clock of its own -- app.js owns all three. That split is
 * what lets this file be imported unchanged by the browser and by jsc,
 * the JavaScriptCore shell macOS ships, so the tests exercise exactly
 * the code the page runs.
 *
 * Four sections:
 *
 *   STATIONS   distance, ranking, complex grouping   (mtastations.py)
 *   FEED       GTFS-Realtime protobuf reader         (mtafeed.py)
 *   BOARD      arrivals -> countdowns                (mtaui.py)
 *   ROUTES     line colours, express, feed routing   (both)
 */


/* == STATIONS =========================================================== */

/* Station geometry: how far away a station is, and how long the walk.
 *
 * A direct port of the pure half of mtastations.py. No I/O, no DOM --
 * the station table is loaded by the caller and passed in, so this
 * module runs unchanged in the browser and under jsc.
 */
const EARTH_MILES = 3958.8;
const WALK_MPH = 3.0;

const radians = (degrees) => degrees * Math.PI / 180;

/** Great-circle miles between two points. */
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const phi1 = radians(lat1);
  const phi2 = radians(lat2);
  const dphi = phi2 - phi1;
  const dlambda = radians(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(a));
}

/** Rough walking time, for deciding whether a train is catchable. */
export function walkMinutes(miles) {
  return miles / WALK_MPH * 60.0;
}

/* The `count` closest complexes, nearest first.
 *
 * One complex, possibly several platforms: Grand Central is three
 * separate rows in the station table (4/5/6, 7, and the shuttle) and
 * riders think of it as one station. The table's own complex ID says
 * which rows belong together, which beats guessing from names and
 * distances -- and keeps the six unrelated "86 St" stations separate.
 *
 * A complex is as far away as its nearest entrance and is named for
 * its nearest platform.
 */
export function nearest(stations, lat, lon, count = 3) {
  const ranked = stations
    .map((station) => ({
      miles: distanceMiles(lat, lon, station.lat, station.lon),
      station,
    }))
    .sort((a, b) => a.miles - b.miles);

  const groups = new Map();
  for (const { miles, station } of ranked) {
    const found = groups.get(station.complexId);
    if (found) {
      found.stations.push(station);
    } else {
      groups.set(station.complexId,
                 { name: station.name, miles, stations: [station] });
    }
  }
  return [...groups.values()].slice(0, count);
}

/* Expand stations.json into station records.
 *
 * The file is columnar -- a field list plus plain rows -- so the nine
 * key names are not repeated for every station in the system. That is
 * most of the difference between a 90KB download and a 40KB one.
 */
export function parseStations(table) {
  const index = {};
  table.fields.forEach((field, at) => { index[field] = at; });
  return table.rows.map((row) => ({
    stopId: row[index.stopId],
    complexId: row[index.complexId],
    name: row[index.name],
    borough: row[index.borough],
    routes: row[index.routes].split(" "),
    lat: row[index.lat],
    lon: row[index.lon],
    north: row[index.north],
    south: row[index.south],
  }));
}

/* == FEED =============================================================== */

/* GTFS-Realtime reader for the MTA subway feeds, in plain JavaScript.
 *
 * A port of mtafeed.py. The feeds are protobuf, but we only need six
 * fields out of them, so rather than take a dependency this module
 * walks the wire format directly. `readFields` is a generic protobuf
 * scanner; `parseFeed` knows the handful of GTFS-Realtime field
 * numbers we care about:
 *
 *     FeedMessage.header(1).timestamp(3)
 *     FeedMessage.entity(2).trip_update(3)
 *         .trip(1).route_id(5)
 *         .stop_time_update(2).stop_id(4)
 *         .stop_time_update(2).arrival(2).time(2)
 *                             .departure(3).time(2)
 *
 * Those numbers are frozen by the GTFS-Realtime spec, so the risk of
 * the feed drifting out from under us is about as low as a wire format
 * gets.
 *
 * Everything here is pure: `fetch` lives in the caller, which keeps
 * this file runnable under jsc, where there is no network.
 */

/* Decode a base-128 varint at `i`; return [value, nextIndex].
 *
 * Bits are accumulated by multiplication rather than with `<<`,
 * because JavaScript's bitwise operators truncate to a signed 32-bit
 * int -- which would silently corrupt a feed timestamp as it nears
 * 2^31. Multiplication stays exact to 2^53.
 */
export function readVarint(buf, i) {
  let result = 0;
  let scale = 1;
  for (;;) {
    const byte = buf[i];
    if (byte === undefined) throw new Error("truncated varint");
    i += 1;
    result += (byte & 0x7F) * scale;
    if (!(byte & 0x80)) return [result, i];
    scale *= 128;
  }
}

/* Yield [fieldNumber, value] for one protobuf message.
 *
 * Length-delimited fields come back as a Uint8Array view, everything
 * else as a number. Groups (wire types 3 and 4) never appear in
 * GTFS-Realtime and throw, so a malformed buffer fails loudly instead
 * of silently producing half a feed.
 */
export function* readFields(buf, start = 0, end = buf.length) {
  let i = start;
  while (i < end) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value;
    if (wire === 0) {
      [value, i] = readVarint(buf, i);
    } else if (wire === 2) {
      let length;
      [length, i] = readVarint(buf, i);
      value = buf.subarray(i, i + length);
      i += length;
    } else if (wire === 5) {
      value = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
      i += 4;
    } else if (wire === 1) {
      value = 0;
      for (let k = 7; k >= 0; k -= 1) value = value * 256 + buf[i + k];
      i += 8;
    } else {
      throw new Error("unsupported protobuf wire type " + wire);
    }
    yield [field, value];
  }
}

/* UTF-8 bytes to a string, malformed sequences replaced.
 *
 * Hand-rolled because jsc has no TextDecoder, and because the ids we
 * decode ("635N", "6") are ASCII in practice -- so this costs nothing
 * and keeps the module runnable outside a browser.
 */
export function decodeUtf8(buf) {
  let out = "";
  let i = 0;
  while (i < buf.length) {
    const byte = buf[i];
    let point;
    let extra;
    if (byte < 0x80) { point = byte; extra = 0; }
    else if ((byte & 0xE0) === 0xC0) { point = byte & 0x1F; extra = 1; }
    else if ((byte & 0xF0) === 0xE0) { point = byte & 0x0F; extra = 2; }
    else if ((byte & 0xF8) === 0xF0) { point = byte & 0x07; extra = 3; }
    else { out += "�"; i += 1; continue; }

    let ok = true;
    for (let k = 1; k <= extra; k += 1) {
      const next = buf[i + k];
      if (next === undefined || (next & 0xC0) !== 0x80) { ok = false; break; }
      point = (point << 6) | (next & 0x3F);
    }
    if (!ok) { out += "�"; i += 1; continue; }
    out += String.fromCodePoint(point);
    i += extra + 1;
  }
  return out;
}

/** The first occurrence of `field` in a message, or null. */
function first(buf, field) {
  for (const [number, value] of readFields(buf)) {
    if (number === field) return value;
  }
  return null;
}

/* [stopId, epochSeconds] from one StopTimeUpdate, or null.
 *
 * Terminals often publish only a departure, so arrival is preferred
 * and departure is the fallback.
 */
function stopTime(buf) {
  let stopId = null;
  let arrival = null;
  let departure = null;
  for (const [field, value] of readFields(buf)) {
    if (field === 4) stopId = decodeUtf8(value);
    else if (field === 2) arrival = first(value, 2);
    else if (field === 3) departure = first(value, 2);
  }
  const when = arrival !== null ? arrival : departure;
  return stopId && when !== null ? [stopId, when] : null;
}

/* [feedTimestamp, trips] from one GTFS-Realtime feed body.
 *
 * A trip is a train: its route and the stops it still has to make, in
 * order. The stop list is the reason this is worth keeping rather than
 * flattening on the spot -- it is what lets the board answer "where
 * does this train go next" without asking the network again.
 *
 * Trip updates with no route or no usable stop times are skipped
 * rather than throwing: a single malformed entity should cost you one
 * train, not the whole screen.
 */
export function parseFeed(data) {
  let timestamp = null;
  const trips = [];
  for (const [field, value] of readFields(data)) {
    if (field === 1) {
      timestamp = first(value, 3);
    } else if (field === 2) {
      const update = first(value, 3);
      if (update === null) continue;
      let route = null;
      const stops = [];
      for (const [number, inner] of readFields(update)) {
        if (number === 1) {
          const routeId = first(inner, 5);
          if (routeId !== null) route = decodeUtf8(routeId);
        } else if (number === 2) {
          const stop = stopTime(inner);
          if (stop) stops.push({ stopId: stop[0], when: stop[1] });
        }
      }
      if (!route || !stops.length) continue;
      trips.push({ route, stops });
    }
  }
  return [timestamp, trips];
}

/* Every stop of every trip, as one flat list.
 *
 * Each arrival points back at the trip it belongs to and the index it
 * sits at, so the stops still ahead of it are `trip.stops.slice(at + 1)`.
 * The trip object is shared, not copied -- five thousand arrivals
 * reference a few hundred trips.
 */
export function arrivalsOf(trips) {
  const arrivals = [];
  for (const trip of trips) {
    trip.stops.forEach((stop, at) => {
      arrivals.push({ route: trip.route, stopId: stop.stopId,
                      when: stop.when, trip, at });
    });
  }
  return arrivals;
}


/* == BOARD ============================================================== */

/* Turning raw arrivals into a board you can read at a glance.
 *
 * A port of the view-model half of mtaui.py -- station_view and its
 * two countdown helpers. Pure: no DOM, no clock of its own. `now` is
 * passed in so the whole board can be tested against fixed data.
 */
const MAX_COUNTDOWNS = 3;   // a fourth train is never the one you run for
const DEPARTED = -1.0;      // keep a train visible this long after it leaves

/** Whole minutes from `now` until `when`, rounded down. */
export function minutesUntil(when, now) {
  return Math.floor((when - now) / 60);
}

export function formatCountdown(minutes) {
  return minutes < 1 ? "now" : minutes + "m";
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* One board for the arrivals touching a complex.
 *
 * Arrivals are matched by stop ID prefix across every platform in the
 * complex, and the N/S suffix says which heading a train belongs
 * under. Trains already gone are dropped, and each heading keeps only
 * the next few.
 */
export function stationView(place, arrivals, now) {
  const byHeading = new Map();

  for (const station of place.stations) {
    for (const arrival of arrivals) {
      if (!arrival.stopId.startsWith(station.stopId)) continue;
      const suffix = arrival.stopId.slice(station.stopId.length);
      if (suffix !== "N" && suffix !== "S") continue;
      const minutes = minutesUntil(arrival.when, now);
      if (minutes < DEPARTED) continue;
      const heading = suffix === "N" ? station.north : station.south;
      const key = JSON.stringify([arrival.route, heading]);
      const found = byHeading.get(key);
      if (found) found.trains.push({ minutes, arrival });
      else byHeading.set(key, { route: arrival.route, heading,
                                trains: [{ minutes, arrival }] });
    }
  }

  const departures = [...byHeading.values()].map((each) => {
    each.trains.sort((a, b) => a.minutes - b.minutes);
    return {
      route: each.route,
      heading: each.heading,
      minutes: each.trains.map((t) => t.minutes).slice(0, MAX_COUNTDOWNS),
      // the stops still ahead of the train you would actually board
      ahead: stopsAhead(each.trains[0].arrival),
    };
  });
  departures.sort((a, b) =>
    a.minutes[0] - b.minutes[0]
    || compare(a.route, b.route)
    || compare(a.heading, b.heading));

  const routes = [...new Set(place.stations.flatMap((s) => s.routes))].sort();

  // The nearest platform stands for the whole complex, the way its name
  // does -- near enough to walk to, and enough to put a pin on a map.
  const nearest = place.stations[0];

  return {
    name: place.name,
    miles: place.miles,
    walk: walkMinutes(place.miles),
    lat: nearest ? nearest.lat : null,
    lon: nearest ? nearest.lon : null,
    routes,
    departures,
  };
}

/* Tell same-named stations apart by the lines they serve.
 *
 * Manhattan has two 23 St stations three minutes apart on different
 * lines; stacked on one screen under the same heading they are
 * useless, so a duplicated name picks up its routes.
 */
export function disambiguate(views) {
  const counts = new Map();
  for (const view of views) {
    counts.set(view.name, (counts.get(view.name) || 0) + 1);
  }
  return views.map((view) =>
    counts.get(view.name) > 1 && view.routes.length
      ? { ...view, name: view.name + " (" + view.routes.join("/") + ")" }
      : view);
}

/* Whether you could still make this train on foot.
 *
 * The useful signal on a countdown board is not which train is
 * closest, it is which trains you can still catch -- a train arriving
 * now is the one you have already missed if the station is a six
 * minute walk away.
 */
export function isCatchable(minutes, walk) {
  return minutes >= walk;
}

/* Gather a station's departures under the line they run on.
 *
 * A board sorted purely by which train comes soonest answers "what
 * leaves first", but at a station you already know which train you
 * want -- so the F rows sit together, then the M rows.
 *
 * Every line at the station is returned -- a station with six lines
 * gives six groups. The `max` applies within a line: each keeps its
 * two soonest directions, reports how many it dropped, and carries the
 * full list so it can unfold.
 *
 * Lines are ordered by name rather than by imminence, because a list
 * that reshuffles itself every thirty seconds cannot be scanned; an
 * express is sorted next to the local it runs with.
 */
export function groupByRoute(departures, max = 2) {
  const groups = new Map();
  for (const departure of departures) {
    const found = groups.get(departure.route);
    if (found) found.push(departure);
    else groups.set(departure.route, [departure]);
  }

  const out = [];
  for (const [route, found] of groups) {
    found.sort((a, b) => a.minutes[0] - b.minutes[0]);
    out.push({
      route,
      departures: found.slice(0, max),
      all: found,                    // every direction, for a line that unfolds
      hidden: Math.max(0, found.length - max),
    });
  }
  // baseRoute keeps 6X beside 6; the flag breaks the tie after it.
  out.sort((a, b) =>
    compare(baseRoute(a.route), baseRoute(b.route))
    || compare(isExpress(a.route), isExpress(b.route)));
  return out;
}


/* The stops a train still has to make after this one.
 *
 * Arrivals built by hand (in tests, or from a feed that gave us
 * nothing) carry no trip, and simply have nothing ahead of them.
 */
export function stopsAhead(arrival) {
  if (!arrival || !arrival.trip) return [];
  return arrival.trip.stops.slice(arrival.at + 1);
}

/* A lookup from stop ID to station name.
 *
 * Realtime stop IDs are the station ID plus an N/S suffix, so one
 * table answers for both directions.
 */
export function stopNames(stations) {
  const names = new Map();
  for (const station of stations) names.set(station.stopId, station.name);
  return names;
}

export function stopName(names, stopId) {
  const base = stopId.replace(/[NS]$/, "");
  return names.get(base) || base;
}


/* == ROUTES ============================================================= */

/* Facts about subway routes: what colour a line is, and which feed
 * carries it.
 *
 * Ports the route tables from mtafeed.py and mtaui.py. The terminal's
 * colour-degrading machinery (xterm256, the eight-colour fallback) is
 * deliberately left behind -- a browser has real colour.
 */

const BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";

// Official MTA line colours, straight off the bullets.
export const STYLE_HEX = {
  red: "#EE352E",      // 1 2 3
  green: "#00933C",    // 4 5 6
  purple: "#B933AD",   // 7
  blue: "#0039A6",     // A C E, and the Staten Island Railway
  orange: "#FF6319",   // B D F M
  lime: "#6CBE45",     // G
  brown: "#996633",    // J Z
  yellow: "#FCCC0A",   // N Q R W
  silver: "#A7A9AC",   // L
  slate: "#808183",    // the shuttles
};

const ROUTE_STYLE = {};
for (const [routes, style] of [
  ["123", "red"], ["456", "green"], ["7", "purple"],
  ["ACE", "blue"], ["BDFM", "orange"], ["G", "lime"],
  ["JZ", "brown"], ["NQRW", "yellow"], ["L", "silver"],
]) {
  for (const route of routes) ROUTE_STYLE[route] = style;
}
// The Staten Island Railway rides under a blue bullet; the three
// shuttles (42 St, Franklin Av, Rockaway Park) share the grey one.
Object.assign(ROUTE_STYLE, {
  SI: "blue", SS: "blue", GS: "slate", FS: "slate", H: "slate",
});

// Verified against the live feeds, not from memory: the three "S"
// shuttles land in three different places (FS=Franklin, GS=42 St,
// H=Rockaway). Express variants are handled by rule in feedForRoute
// rather than listed here.
const FEED_BY_ROUTE = {
  1: "gtfs", 2: "gtfs", 3: "gtfs", 4: "gtfs", 5: "gtfs",
  6: "gtfs", 7: "gtfs", GS: "gtfs",
  A: "gtfs-ace", C: "gtfs-ace", E: "gtfs-ace", H: "gtfs-ace",
  B: "gtfs-bdfm", D: "gtfs-bdfm", F: "gtfs-bdfm",
  M: "gtfs-bdfm", FS: "gtfs-bdfm",
  G: "gtfs-g",
  J: "gtfs-jz", Z: "gtfs-jz",
  N: "gtfs-nqrw", Q: "gtfs-nqrw", R: "gtfs-nqrw", W: "gtfs-nqrw",
  L: "gtfs-l",
  SI: "gtfs-si", SS: "gtfs-si",     // SS is the SIR shuttle
};

/* The line an express variant runs on: 6X is a 6, FX is an F.
 *
 * The MTA prints express service as a diamond and local as a circle,
 * and the X in the feed's route ID is just how that diamond is
 * spelled.
 */
export function baseRoute(route) {
  if (route.endsWith("X") && ROUTE_STYLE[route.slice(0, -1)]) {
    return route.slice(0, -1);
  }
  return route;
}

export function isExpress(route) {
  return baseRoute(route) !== route;
}

/* Colour name for a route bullet.
 *
 * Express variants take the colour of the line they run on, so they
 * read as the same line rather than as something unknown.
 */
export function routeStyle(route) {
  return ROUTE_STYLE[baseRoute(route)] || "slate";
}

/** CSS colour for a route bullet. */
export function routeColor(route) {
  return STYLE_HEX[routeStyle(route)];
}

/* The feed carrying a route, or null if we do not know it.
 *
 * An X suffix marks express service and rides in the same feed as its
 * line, so 6X falls back to 6. Handling that by rule means a new
 * express variant needs no code change.
 */
export function feedForRoute(route) {
  if (FEED_BY_ROUTE[route]) return FEED_BY_ROUTE[route];
  if (route.endsWith("X")) return FEED_BY_ROUTE[route.slice(0, -1)] || null;
  return null;
}

/** The distinct feed names serving `routes`, unknown routes ignored. */
export function feedsForRoutes(routes) {
  const found = new Set();
  for (const route of routes) {
    const feed = feedForRoute(route);
    if (feed) found.add(feed);
  }
  return [...found].sort();
}

export function feedUrl(name) {
  return BASE + name;
}
