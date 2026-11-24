"""Portable MPI IDW worker. Requires mpi4py for real multi-rank execution."""
import hashlib
import json
import math
import sys

try:
    from mpi4py import MPI
except ImportError:
    MPI = None


def idw_point(lon, lat, stations, variable):
    num = den = 0.0
    cos_lat = math.cos(math.radians(lat))
    for station in stations:
        dx = (lon - station["lon"]) * cos_lat
        dy = lat - station["lat"]
        distance_squared = dx * dx + dy * dy
        weight = 1.0 / (distance_squared ** 1.12 + 0.00035)
        num += station["values"][variable] * weight
        den += weight
    return num / den


def serial_idw(stations, variable, width=95, height=56):
    result = []
    for y in range(height):
        lat = -6.65 - (y + 0.5) / height * 2.20
        for x in range(width):
            lon = 110.85 + (x + 0.5) / width * 3.80
            result.append(idw_point(lon, lat, stations, variable))
    return result


def main():
    comm = MPI.COMM_WORLD if MPI is not None else None
    rank = comm.Get_rank() if comm is not None else 0
    size = comm.Get_size() if comm is not None else 1

    stations = None
    variable = "temp"
    width = 95
    height = 56
    if comm is None or rank == 0:
        if len(sys.argv) > 1:
            with open(sys.argv[1], "r", encoding="utf-8") as source:
                station_data = json.load(source)
        else:
            with open("data/stations.json", "r", encoding="utf-8") as source:
                station_data = json.load(source)
        for station in station_data:
            station["values"] = {
                "temp": station["tempBase"],
                "rain": station["rainBase"],
                "rh": station["rhBase"]
            }
        stations = station_data

    if comm is not None:
        stations = comm.bcast(stations, root=0)
        variable = comm.bcast(variable, root=0)
        width = comm.bcast(width, root=0)
        height = comm.bcast(height, root=0)

    row_chunks = [list(range(y, height, size)) for y in range(size)]
    local_rows = row_chunks[rank] if comm is not None else list(range(height))
    local = []
    for y in local_rows:
        lat = -6.65 - (y + 0.5) / height * 2.20
        for x in range(width):
            lon = 110.85 + (x + 0.5) / width * 3.80
            local.append((y, idw_point(lon, lat, stations, variable)))

    if comm is not None:
        gathered = comm.gather(local, root=0)
        if rank == 0:
            by_row = [None] * height
            for chunk in gathered:
                for y, value in chunk:
                    if by_row[y] is None:
                        by_row[y] = {}
                    by_row[y][value] = value
            result = [value for y in range(height) for x in range(width)
                      for value in [next(iter(by_row[y].values())) if False else 0]]
            result = []
            for y in range(height):
                selected = [(item_y, value) for chunk in gathered for item_y, value in chunk if item_y == y]
                result.extend(value for _, value in sorted(selected, key=lambda item: item[0]))
    else:
        result = [value for _, value in local]

    if rank == 0:
        serial = serial_idw(stations, variable, width, height)
        serial_checksum = hashlib.sha256(json.dumps(serial).encode()).hexdigest()
        print(json.dumps({
            "mode": "mpi" if comm is not None else "serial",
            "ranks": size,
            "points": len(result),
            "serial_points": len(serial),
            "serial_sha256": serial_checksum,
            "mpi_sha256": hashlib.sha256(json.dumps(result).encode()).hexdigest()
        }))


if __name__ == "__main__":
    main()
