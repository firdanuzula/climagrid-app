"""MPI analytics worker with deterministic serial fallback.

Run:
  python analytics/mpi_idw.py --case idw --stations data/stations.json
  mpiexec -n 4 python analytics/mpi_idw.py --case idw --stations data/stations.json
  mpiexec -n 4 python analytics/mpi_idw.py --case stats --values 1,2,3,4,5,6
"""
import argparse
import hashlib
import json
import math
import sys

try:
    from mpi4py import MPI
except ImportError:
    MPI = None


def checksum(values):
    encoded = json.dumps(values, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_stations(filename):
    with open(filename, "r", encoding="utf-8") as source:
        stations = json.load(source)
    for station in stations:
        if not station.get("values"):
            station["values"] = {
                "temp": station["tempBase"],
                "rain": station["rainBase"],
                "rh": station["rhBase"],
            }
    return stations


def idw_point(lon, lat, stations, variable, time_offset):
    numerator = 0.0
    denominator = 0.0
    cos_latitude = math.cos(math.radians(lat))
    for station in stations:
        dx = (lon - station["lon"]) * cos_latitude
        dy = lat - station["lat"]
        distance_squared = dx * dx + dy * dy
        weight = 1.0 / (distance_squared ** 1.12 + 0.00035)
        value = station["values"][variable]
        if time_offset:
            value -= time_offset * ((lon + lat) % 0.1)
        numerator += value * weight
        denominator += weight
    return round(numerator / denominator, 3)


def serial_idw(stations, variable, time_offset, width, height):
    values = []
    for y in range(height):
        lat = -6.65 - (y + 0.5) / height * 2.2
        for x in range(width):
            lon = 110.85 + (x + 0.5) / width * 3.8
            values.append(idw_point(lon, lat, stations, variable, time_offset))
    return values


def parallel_idw(comm, rank, size, stations, variable, time_offset, width, height):
    if rank == 0:
        config = {
            "variable": variable,
            "time_offset": time_offset,
            "width": width,
            "height": height,
            "stations": stations,
        }
    else:
        config = None
    config = comm.bcast(config, root=0)

    if rank == 0:
        row_chunks = [list(range(rank_index, height, size)) for rank_index in range(size)]
    else:
        row_chunks = None
    rows = comm.scatter(row_chunks, root=0)

    local_rows = []
    for y in rows:
        lat = -6.65 - (y + 0.5) / config["height"] * 2.2
        row = []
        for x in range(config["width"]):
            lon = 110.85 + (x + 0.5) / config["width"] * 3.8
            row.append(idw_point(
                lon, lat, config["stations"], config["variable"], config["time_offset"]
            ))
        local_rows.append((y, row))

    gathered = comm.gather(local_rows, root=0)
    if rank != 0:
        return None
    ordered_rows = sorted((item for chunk in gathered for item in chunk), key=lambda item: item[0])
    return [value for _, row in ordered_rows for value in row]


def moving_averages(values, window):
    averages = []
    for index in range(len(values)):
        start = max(0, index - window + 1)
        subset = values[start:index + 1]
        averages.append(sum(subset) / len(subset))
    return averages


def serial_stats(values, window):
    if not values:
        return {"count": 0, "sum": 0.0, "average": None, "minimum": None,
                "maximum": None, "moving_average": []}
    return {
        "count": len(values),
        "sum": sum(values),
        "average": sum(values) / len(values),
        "minimum": min(values),
        "maximum": max(values),
        "moving_average": moving_averages(values, window),
    }


def split_values(values, size):
    chunks = []
    start = 0
    for rank in range(size):
        length = len(values) // size + (1 if rank < len(values) % size else 0)
        chunks.append({"start": start, "values": values[start:start + length]})
        start += length
    return chunks


def parallel_stats(comm, rank, size, values, window):
    if rank == 0:
        config = {"window": window, "count": len(values)}
        chunks = split_values(values, size)
    else:
        config = None
        chunks = None
    config = comm.bcast(config, root=0)
    local_chunk = comm.scatter(chunks, root=0)
    local = local_chunk["values"]
    start = local_chunk["start"]
    radius = max(0, config["window"] - 1)

    left_receive = comm.irecv(source=rank - 1, tag=301) if rank > 0 else None
    right_receive = comm.irecv(source=rank + 1, tag=302) if rank + 1 < size else None
    left_send = comm.isend(local[:radius], dest=rank - 1, tag=302) if rank > 0 else None
    right_send = comm.isend(local[-radius:] if radius else [], dest=rank + 1, tag=301) if rank + 1 < size else None

    left_halo = left_receive.wait() if left_receive else []
    if right_receive:
        right_receive.wait()
    if left_send:
        left_send.wait()
    if right_send:
        right_send.wait()

    local_sum = sum(local)
    local_min = min(local) if local else math.inf
    local_max = max(local) if local else -math.inf
    total_sum = comm.reduce(local_sum, op=MPI.SUM, root=0)
    total_count = comm.reduce(len(local), op=MPI.SUM, root=0)
    total_min = comm.reduce(local_min, op=MPI.MIN, root=0)
    total_max = comm.reduce(local_max, op=MPI.MAX, root=0)

    local_moving = []
    for offset, value in enumerate(local):
        global_index = start + offset
        left_needed = min(radius, global_index)
        previous = left_halo[-left_needed:] if left_needed else []
        sample = previous + local[:offset + 1]
        sample = sample[-config["window"]:]
        local_moving.append((global_index, sum(sample) / len(sample)))
    gathered_moving = comm.gather(local_moving, root=0)

    if rank != 0:
        return None
    moving = [
        value for _, value in sorted(
            (item for chunk in gathered_moving for item in chunk),
            key=lambda item: item[0]
        )
    ]
    return {
        "count": total_count,
        "sum": total_sum,
        "average": total_sum / total_count if total_count else None,
        "minimum": total_min if total_count else None,
        "maximum": total_max if total_count else None,
        "moving_average": moving,
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=("idw", "stats"), default="idw")
    parser.add_argument("--stations", default="data/stations.json")
    parser.add_argument("--variable", choices=("temp", "rain", "rh"), default="temp")
    parser.add_argument("--time", type=int, default=0)
    parser.add_argument("--width", type=int, default=95)
    parser.add_argument("--height", type=int, default=56)
    parser.add_argument("--values", default="1,2,3,4,5,6,7,8,9,10,11,12")
    parser.add_argument("--window", type=int, default=3)
    return parser.parse_args()


def main():
    args = parse_args()
    comm = MPI.COMM_WORLD if MPI is not None else None
    rank = comm.Get_rank() if comm is not None else 0
    size = comm.Get_size() if comm is not None else 1

    if args.width < 1 or args.height < 1 or args.window < 1:
        raise ValueError("width, height, and window must be positive")

    if args.case == "idw":
        stations = load_stations(args.stations) if rank == 0 else None
        if comm is not None:
            config = comm.bcast(
                {"variable": args.variable, "time": args.time, "width": args.width,
                 "height": args.height, "stations": stations} if rank == 0 else None,
                root=0,
            )
            result = parallel_idw(
                comm, rank, size, config["stations"], config["variable"],
                config["time"], config["width"], config["height"]
            )
        else:
            result = serial_idw(stations, args.variable, args.time, args.width, args.height)
        if rank == 0:
            reference = serial_idw(stations, args.variable, args.time, args.width, args.height)
            print(json.dumps({
                "case": "idw",
                "mode": "mpi" if comm is not None else "serial-fallback",
                "ranks": size,
                "points": len(result),
                "serial_points": len(reference),
                "serial_sha256": checksum(reference),
                "mpi_sha256": checksum(result),
                "match": checksum(reference) == checksum(result),
                "values": result,
            }))
    else:
        values = [float(value) for value in args.values.split(",") if value.strip()] if rank == 0 else None
        if comm is not None:
            result = parallel_stats(comm, rank, size, values, args.window)
        else:
            result = serial_stats(values, args.window)
        if rank == 0:
            reference = serial_stats(values, args.window)
            print(json.dumps({
                "case": "stats",
                "mode": "mpi" if comm is not None else "serial-fallback",
                "ranks": size,
                "result": result,
                "serial_sha256": checksum(reference),
                "mpi_sha256": checksum(result),
                "match": checksum(reference) == checksum(result),
            }))


if __name__ == "__main__":
    main()
