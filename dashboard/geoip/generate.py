#!/usr/bin/env python3
"""Builds country-ipv4.bin.gz from DB-IP's IP to Country Lite (CC BY 4.0, https://db-ip.com).

Usage: generate.py YYYY-MM | generate.py path/to/dbip-country-lite-YYYY-MM.csv.gz

Layout, all gzipped: b"GEO4", a u8 country count and two ASCII bytes per country, a u32 LE row
count, each row's first address as a LEB128 delta from the previous row's, then each row's
country index (255 where DB-IP has none). A row runs until the next row's first address.
"""

import csv
import gzip
import io
import ipaddress
import struct
import sys
import urllib.request
from pathlib import Path

UNKNOWN = 255
OUT = Path(__file__).with_name("country-ipv4.bin.gz")


def leb128(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | 0x80 if value else byte)
        if not value:
            return bytes(out)


def read(source):
    if Path(source).is_file():
        return Path(source).read_bytes()
    url = f"https://download.db-ip.com/free/dbip-country-lite-{source}.csv.gz"
    with urllib.request.urlopen(url) as reply:
        return reply.read()


def main(source):
    rows = []
    with gzip.open(io.BytesIO(read(source)), "rt", newline="") as text:
        for first, last, code in csv.reader(text):
            if ":" in first:
                continue
            rows.append((int(ipaddress.IPv4Address(first)), int(ipaddress.IPv4Address(last)), code))
    rows.sort()

    codes = sorted({code for _, _, code in rows if code != "ZZ"})
    assert len(codes) < UNKNOWN, f"{len(codes)} countries do not fit a byte"
    index = {code: at for at, code in enumerate(codes)}

    starts, countries, end = [], [], 0
    for first, last, code in rows:
        if first != end:
            starts.append(end)
            countries.append(UNKNOWN)
        country = index.get(code, UNKNOWN)
        if not countries or countries[-1] != country:
            starts.append(first)
            countries.append(country)
        end = last + 1
    if end != 2**32:
        starts.append(end)
        countries.append(UNKNOWN)

    packed = bytearray(b"GEO4")
    packed += bytes([len(codes)]) + "".join(codes).encode("ascii")
    packed += struct.pack("<I", len(starts))
    previous = 0
    for start in starts:
        packed += leb128(start - previous)
        previous = start
    packed += bytes(countries)
    OUT.write_bytes(gzip.compress(bytes(packed), compresslevel=9, mtime=0))
    print(f"{len(starts)} ranges, {len(codes)} countries, {OUT.stat().st_size} bytes -> {OUT}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
