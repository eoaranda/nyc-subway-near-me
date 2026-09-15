# NYC Subway Near Me

A small web page. It shows the next subway trains near you.

Open it, allow location, and you see the closest stations and when the
next trains arrive.

Live: https://subway.earanda.dev/

## What you see

- The closest stations, nearest first.
- Trains grouped by line. All F rows together, then all M rows.
- Every line at the station is listed. A station with 6 lines shows
  all 6.
- Each line shows 2 directions. Each direction shows the next 3 trains.
  So 6 lines means 12 rows.
- A time is **green** if you can still walk there in time. Grey means
  you cannot. A train arriving *now* is not useful if the walk is 6 minutes.
- Tap a row to see every stop that train makes next.
- Tap the pin next to the walk time to open that station in Google Maps.

## How to use it

Just open the page and allow location.

You can also skip location. Add the position to the address:

    ?lat=40.7359&lon=-73.9911

Options:

| Option | What it does |
|---|---|
| `?lat=` `&lon=` | use this position, do not ask for location |
| `?n=` | how many stations to show (1 to 8, default 3) |

## Put it online

Upload these 5 files. Nothing else:

    index.html
    app.js
    core.js
    stations.json
    favicon.ico

Any static host works: GitHub Pages, Netlify, Cloudflare, S3.

## Run it on your computer

    python3 -m http.server 8777

Then open http://localhost:8777

Do not open the file directly (`file://`). It will not work. The page
needs a server.

## Files

    index.html        the page and the styles
    app.js            location, network, screen
    core.js           all the logic
    stations.json     496 stations
    favicon.ico       the icon (16, 32 and 48 pixels)

These are only for development. Do not upload them:

    make-stations.py  rebuilds stations.json
    README.md         this file

## How it works

There is no server and no database. The page does everything:

1. The browser gives the position.
2. `stations.json` gives the closest stations.
3. The page downloads the MTA realtime feeds and reads them.
4. The page shows the result.

The MTA feeds allow this because they send
`access-control-allow-origin: *`. No API key is needed.

It refreshes every 30 seconds. The countdowns update every second. When
the tab is hidden, it stops.

## Privacy

Your position never leaves your browser. The page only talks to the MTA.

## Rebuild the station list

Only needed if the MTA changes its station data:

    ./make-stations.py

This uses Python. The website itself does not use Python.
