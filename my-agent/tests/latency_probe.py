"""Event-loop latency probe for the scan route.

Answers one question: while a scan is being analysed, does the server still
answer other requests?

How it works
------------
* Starts the real FastAPI app in a separate uvicorn process, with the Bedrock
  vision call swapped for a fake that sleeps for SCAN_SECONDS (as a real
  analysis would) and S3 swapped for a no-op. Nothing touches AWS.
* Fires a POST /analyze, waits half a second, then times a GET / health check.
* If the health check takes ~SCAN_SECONDS, the scan blocked the event loop.
  If it takes a few milliseconds, it did not.

Run it from the my-agent folder:

    .\\venv\\Scripts\\python.exe tests\\latency_probe.py

No .env or credentials are needed.
"""
import os
import sys
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

# Import-time requirements of auth.py / server.py. Dummy values are fine: the
# probe overrides authentication and never talks to S3.
os.environ.setdefault("FINCORE_SESSION_SECRET", "probe-only-not-a-real-secret")
os.environ.setdefault("FINCORE_S3_BUCKET", "probe-bucket-never-used")

SCAN_SECONDS = 3.0
PORT = 8765

# A 1x1 white JPEG, base64-encoded, so the request body is valid.
TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////"
    "////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAA"
    "AAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
)


# ---------------------------------------------------------------------------
# Server side: uvicorn imports this module and reads `app`
# ---------------------------------------------------------------------------
def _build_patched_app():
    import server  # noqa: WPS433 (deliberate late import, after env is set)

    def fake_analyze_image(*args, **kwargs):
        # Stand-in for the Bedrock vision call. Blocking sleep on purpose: this
        # is exactly what boto3 does while it waits for the model.
        time.sleep(SCAN_SECONDS)
        return {
            "product_identified": "Probe product",
            "overall_score": 50,
            "grade": "C",
            "verdict": "Probe verdict",
            "color": "amber",
            "breakdown": {"value_for_money": 50, "necessity": 50, "budget_impact": 50},
            "recommendations": ["none"],
            "financial_insight": "probe",
            "alternatives": ["none"],
        }

    class FakeS3:
        def put_object(self, **kwargs):
            return {}

    server.analyze_image = fake_analyze_image
    server._s3 = lambda: FakeS3()
    server.get_profile = lambda *a, **k: {}
    server.app.dependency_overrides[server.get_current_user] = lambda: "probe-user"
    return server.app


if __name__ != "__main__":
    app = _build_patched_app()


# ---------------------------------------------------------------------------
# Client side: `python tests/latency_probe.py`
# ---------------------------------------------------------------------------
def _main():
    import subprocess
    import threading

    import httpx

    base = f"http://127.0.0.1:{PORT}"
    env = dict(os.environ, PYTHONPATH=str(BACKEND_ROOT))

    print(f"Starting patched server on port {PORT} ...")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "latency_probe:app", "--port", str(PORT), "--log-level", "warning"],
        cwd=str(Path(__file__).resolve().parent),
        env=env,
    )

    try:
        # Wait for the server to come up.
        for _ in range(50):
            try:
                if httpx.get(f"{base}/", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        else:
            print("Server did not start. Is uvicorn installed in the venv?")
            return 1

        # Baseline: health check with the server idle.
        t = time.perf_counter()
        httpx.get(f"{base}/", timeout=10)
        idle_ms = (time.perf_counter() - t) * 1000

        # Fire the scan on a background thread (it will take SCAN_SECONDS).
        scan_result = {}

        def do_scan():
            t0 = time.perf_counter()
            r = httpx.post(
                f"{base}/analyze",
                json={"image_base64": TINY_JPEG_B64, "media_type": "image/jpeg"},
                timeout=30,
            )
            scan_result["seconds"] = time.perf_counter() - t0
            scan_result["status"] = r.status_code
            scan_result["ok"] = r.json().get("success")

        scan_thread = threading.Thread(target=do_scan)
        scan_thread.start()

        # Half a second in, while the scan is still "analysing", time a health check.
        time.sleep(0.5)
        t = time.perf_counter()
        httpx.get(f"{base}/", timeout=30)
        during_ms = (time.perf_counter() - t) * 1000

        scan_thread.join()

        print()
        print(f"Health check, server idle:        {idle_ms:8.1f} ms")
        print(f"Health check, during a scan:      {during_ms:8.1f} ms")
        print(f"Scan itself:                      {scan_result.get('seconds', 0):8.2f} s  "
              f"(HTTP {scan_result.get('status')}, success={scan_result.get('ok')})")
        print()
        if during_ms > SCAN_SECONDS * 1000 * 0.5:
            print("RESULT: BLOCKED. The scan froze the event loop; other requests waited for it.")
        else:
            print("RESULT: NOT BLOCKED. Other requests were served while the scan ran.")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(_main())
