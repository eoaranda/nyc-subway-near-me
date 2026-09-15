#!/usr/bin/env python3
"""Bake ../subway-stations.csv into stations.json.

Build-time only -- the site itself is HTML and JavaScript and needs no
Python at all. This exists so the station table can be regenerated when
the MTA updates its open-data export, without hand-editing JSON.

It reuses mtastations.load so the route normalisation (SIR -> SI, and
the three different "S" shuttles) stays identical to the CLI's.

  ./make-stations.py        # writes stations.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import mtastations as ms

FIELDS = ["stopId", "complexId", "name", "borough", "routes",
          "lat", "lon", "north", "south"]


def main():
    stations = ms.load()
    rows = [[s.stop_id, s.complex_id, s.name, s.borough, " ".join(s.routes),
             round(s.lat, 6), round(s.lon, 6), s.north, s.south]
            for s in stations]
    target = os.path.join(HERE, "stations.json")
    with open(target, "w") as handle:
        json.dump({"fields": FIELDS, "rows": rows}, handle,
                  separators=(",", ":"))
        handle.write("\n")
    print("wrote %s (%d stations, %d bytes)"
          % (target, len(rows), os.path.getsize(target)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
