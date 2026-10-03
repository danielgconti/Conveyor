"""CPU-bound example workload: count primes up to N with a sieve.

Contract: read /job/input.json, write /job/output.json, exit 0 on success.

Input:
  {"number": 1000000}
Optional knobs for demonstrating platform behaviour:
  "sleepSeconds": 30   -> sleep first (try it with a short timeout, or cancel it)
  "exitCode": 1        -> exit with this code instead of succeeding (try it with retries)
"""

import json
import math
import sys
import time
from pathlib import Path

INPUT = Path("/job/input.json")
OUTPUT = Path("/job/output.json")
MAX_NUMBER = 50_000_000


def count_primes(n: int) -> tuple[int, int]:
    sieve = bytearray([1]) * (n + 1)
    sieve[0:2] = b"\x00\x00"
    for i in range(2, math.isqrt(n) + 1):
        if sieve[i]:
            sieve[i * i :: i] = bytes(len(range(i * i, n + 1, i)))
    largest = next(i for i in range(n, 1, -1) if sieve[i])
    return sum(sieve), largest


def main() -> int:
    payload = json.loads(INPUT.read_text())
    n = payload.get("number")
    if not isinstance(n, int) or not 2 <= n <= MAX_NUMBER:
        print(f"'number' must be an integer between 2 and {MAX_NUMBER}", file=sys.stderr)
        return 2

    if sleep := payload.get("sleepSeconds"):
        print(f"sleeping {sleep}s before starting")
        time.sleep(float(sleep))
    if exit_code := payload.get("exitCode"):
        print(f"exiting with code {exit_code} as requested", file=sys.stderr)
        return int(exit_code)

    print(f"counting primes up to {n:,}")
    start = time.perf_counter()
    count, largest = count_primes(n)
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
    print(f"found {count:,} primes in {elapsed_ms}ms")

    OUTPUT.write_text(json.dumps({"result": {"primeCount": count, "largestPrime": largest}, "elapsedMs": elapsed_ms}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
