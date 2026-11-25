"""Check Linux parent-death handling and tmpfs cleanup across an abrupt exit."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

PORT = 19383


def direct_child(pid):
    for entry in Path("/proc").iterdir():
        if entry.name.isdecimal():
            try:
                if f"PPid:\t{pid}\n" in (entry / "status").read_text():
                    return int(entry.name)
            except FileNotFoundError:
                pass
    raise AssertionError("Xray child not found")


def is_alive(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1][0] != "Z"
    except FileNotFoundError:
        return False


def wait_ready(process):
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError(process.communicate()[1])
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/status", timeout=0.3) as response:
                return json.load(response)
        except OSError:
            time.sleep(0.05)
    raise AssertionError("Panel did not start")


def main():
    with tempfile.TemporaryDirectory(prefix="routehub-crash-") as fixture:
        work = Path(fixture)
        runtime = work / "tmp"
        runtime.mkdir()
        config = work / "config.json"
        config.write_text(json.dumps({"panelPort": PORT, "socksPort": PORT + 1,
                                      "profiles": [], "rules": []}))
        args = ["/lab/routehub-rust-final", "serve", "-config", str(config), "-xray", "/lab/xray",
                "-dns-listen", ""]
        unrelated = runtime / "routehub-rust-unrelated"
        unrelated.mkdir(mode=0o700)
        first = None
        second = None
        try:
            env = os.environ | {"TMPDIR": str(runtime)}
            first = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, text=True)
            wait_ready(first)
            xray = direct_child(first.pid)
            owned, = [entry for entry in runtime.iterdir() if entry != unrelated]
            assert (owned / ".routehub-owner").is_file()
            first.kill()
            first.communicate(timeout=10)

            for _ in range(100):
                if not is_alive(xray):
                    break
                time.sleep(0.02)
            assert not is_alive(xray), "Xray kept running after its parent died"
            assert owned.exists(), "The crash fixture requires leftover files"

            second = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE, text=True)
            wait_ready(second)
            assert unrelated.is_dir() and not owned.exists()
            second.terminate()
            _, stderr = second.communicate(timeout=10)
            assert second.returncode == 0, stderr
            assert list(runtime.iterdir()) == [unrelated]
        finally:
            for process in [first, second]:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.communicate(timeout=10)
    print("PASS: abrupt daemon termination, Xray exit, and owned tmpfs cleanup")


if __name__ == "__main__":
    main()
