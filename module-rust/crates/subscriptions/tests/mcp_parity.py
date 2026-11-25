"""Record and replay the subscriptions CLI fixture harness through rust-anything MCP."""
import json
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[2]
ORIGINAL = WORKSPACE.with_name("module")
sys.path.insert(0, str(WORKSPACE / "tools"))

from mcp import call  # noqa: E402


def invoke(stage, fields):
    result = call("app_" + stage, fields)
    for item in result["content"]:
        if item["type"] == "text":
            print(item["text"], flush=True)
    return result


def run():
    with tempfile.TemporaryDirectory(prefix="routehub-subscription-parity-") as temp:
        repo = Path(temp)
        shim = repo / "probe.go"
        shim.write_text((HERE / "go_overlay_probe.txt").read_text())
        renamed = repo / "renamed_main.go"
        renamed.write_text((ORIGINAL / "main.go").read_text().replace("func main() {", "func originalMain() {", 1))
        overlay = repo / "overlay.json"
        overlay.write_text(json.dumps({"Replace": {
            str(ORIGINAL / "main.go"): str(renamed),
            str(ORIGINAL / "subscription_rust_parity.go"): str(shim),
        }}))
        target = repo / "target"
        subprocess.run(["go", "build", "-overlay", str(overlay), "-o", str(repo / "go-probe"), "."], cwd=ORIGINAL, check=True)
        subprocess.run(["cargo", "build", "--package", "routehub-subscriptions", "--example", "parity", "--no-default-features", "--target-dir", str(target)], cwd=WORKSPACE, check=True)
        shared = {"repo": str(repo), "timeout": 8}
        invoke("record", {
            **shared, "run": [str(repo / "go-probe")],
            "inputs": str(HERE / "parity_cases.jsonl"), "normalize": ["key-order"],
            "traps": False, "name": "routehub-subscription-fixtures",
        })
        result = invoke("replay", {**shared, "build": shlex.join([str(target / "debug/examples/parity")])})
        report = json.loads(next(item["text"] for item in result["content"] if item["type"] == "text"))
        if report["passed"] != report["total"] or report.get("skipped") or report.get("fallback"):
            sys.exit(1)
        print("Evidence files stayed in an isolated temporary workspace.")


if __name__ == "__main__":
    run()
