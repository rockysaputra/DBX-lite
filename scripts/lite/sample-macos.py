#!/usr/bin/env python3
"""Record only explicitly selected DBX/WebKit processes; no database access."""
import argparse
import datetime
import json
import pathlib
import platform
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--label", required=True)
parser.add_argument("--pids", nargs="+", type=int, required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
if platform.system() != "Darwin":
    parser.error("Apple footprint requires macOS")
if any(pid <= 0 for pid in args.pids):
    parser.error("PIDs must be positive")
pids = sorted(set(args.pids))
processes = subprocess.run(
    ["ps", "-p", ",".join(map(str, pids)), "-o", "pid=,rss=,%cpu=,comm="],
    text=True, capture_output=True, check=True,
)
samples = []
for line in processes.stdout.splitlines():
    pid, rss, cpu, command = line.strip().split(None, 3)
    samples.append({"pid": int(pid), "rssBytes": int(rss) * 1024, "cpuPercent": float(cpu), "command": command})
footprint = subprocess.run(
    ["footprint", *[arg for pid in pids for arg in ("-p", str(pid))], "--noCategories"],
    text=True, capture_output=True, timeout=45,
)
record = {
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "label": args.label,
    "macOS": platform.mac_ver()[0],
    "architecture": platform.machine(),
    "processes": samples,
    "rssSumBytes": sum(sample["rssBytes"] for sample in samples),
    "missingPids": sorted(set(pids) - {sample["pid"] for sample in samples}),
    "footprintExitCode": footprint.returncode,
    "footprint": footprint.stdout,
    "footprintErrors": footprint.stderr,
    "note": "Explicit PID attribution required. RSS/physical footprint are not JS heap; sums may include shared pages.",
}
args.output.parent.mkdir(parents=True, exist_ok=True)
with args.output.open("a") as output:
    output.write(json.dumps(record) + "\n")
print(f"Recorded {args.label}: {len(samples)} processes to {args.output}")
