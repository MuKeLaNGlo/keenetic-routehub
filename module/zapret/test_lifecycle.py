"""Exercise the shell lifecycle in a disposable Linux process namespace."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ZAPRET = Path(__file__).resolve().with_name("routehub-zapret")
CHAIN = "RH_ZAPRET_OUT"

FIREWALL = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

family = Path(sys.argv[0]).name
root = Path(os.environ["TEST_ROOT"])
db = root / family
table = json.loads(db.read_text()) if db.exists() else {"OUTPUT": [["-j", "ACCEPT"]]}
assert sys.argv[1:4] == ["-w", "-t", "mangle"]
op, chain, *rule = sys.argv[4:]
if op == "-n":
    assert sys.argv[5:10] == ["-v", "-x", "--line-numbers", "-L", "RH_ZAPRET_OUT"]
    assert ["-j", "NFQUEUE"] == table["RH_ZAPRET_OUT"][0][-4:-2]
    print("1 0 0 NFQUEUE")
    sys.exit(0)
if op == "-S":
    if chain in table:
        for entry in table[chain]:
            print("-A", chain, *entry)
        sys.exit(0)
    sys.exit(1)
if op == "-N":
    assert chain not in table
    table[chain] = []
elif op in ["-C", "-A", "-D", "-F", "-I", "-X"]:
    assert chain in table
    if op == "-C":
        sys.exit(int(rule not in table[chain]))
    if op == "-A":
        if (root / "ipv6-fail").exists() and family == "ip6tables":
            sys.exit(1)
        table[chain].append(rule)
    elif op == "-I":
        position, *rule = rule
        table[chain].insert(int(position) - 1, rule)
    elif op == "-D":
        table[chain].remove(rule)
    elif op == "-F":
        table[chain] = []
    elif op == "-X":
        assert not table[chain]
        assert ["-j", chain] not in table["OUTPUT"]
        del table[chain]
else:
    raise RuntimeError(op)
db.write_text(json.dumps(table))
"""

NFQWS = r"""#!/usr/bin/env python3
import os
from pathlib import Path
import signal
import sys
import time

args = sys.argv[1:]
assert '--fwmark=0x40000000' in args
assert '--lua-desync=stub' in args
if os.environ.get("EXPECT_USERSPACE"):
    idx = args.index("--lua-desync=stub")
    assert args[idx-2:idx] == ["--in-range=x", "--out-range=-n15"]
qnum = next(arg.split('=', 1)[1] for arg in args if arg.startswith('--qnum='))
root = Path(os.environ["TEST_ROOT"])
if '--dry-run' in args:
    (root / 'profile-checked').touch()
    sys.exit(0)
queue = root / "proc/net/netfilter/nfnetlink_queue"
def cleanup(_signal, _frame):
    queue.write_text("")
    sys.exit(0)
signal.signal(signal.SIGTERM, cleanup)
queue.write_text(f"{qnum} {os.getpid()} 0 0 0 0 0 1\n")
while True:
    time.sleep(1)
"""


@unittest.skipUnless(os.geteuid() == 0 and Path("/proc/self/stat").exists() and shutil.which("flock"),
                     "requires Linux root in an isolated container with flock")
class ZapretLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.etc = self.root / "etc"
        self.etc.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.run = self.root / "state"
        self.queue = self.root / "proc/net/netfilter/nfnetlink_queue"
        self.queue.parent.mkdir(parents=True)
        self.queue.touch()
        acct = self.root / "proc/sys/net/netfilter/nf_conntrack_acct"
        acct.parent.mkdir(parents=True)
        acct.write_text("1\n")
        for name, data in [("iptables", FIREWALL), ("ip6tables", FIREWALL), ("nfqws2", NFQWS)]:
            script = self.bin / name
            script.write_text(data)
            script.chmod(0o755)
        self.env = os.environ | {
            "TEST_ROOT": str(self.root),
            "ROUTEHUB_ZAPRET_PATH": str(self.bin) + ":" + os.environ["PATH"],
            "ROUTEHUB_ZAPRET_ETC": str(self.etc),
            "ROUTEHUB_ZAPRET_RUN": str(self.run),
            "ROUTEHUB_ZAPRET_PROC": str(self.root / "proc"),
        }
        self.addCleanup(self.call, "stop")

    def configure(self, *, enabled=1, ipv6=0, voice_ports=""):
        (self.etc / "zapret.conf").write_text(
            f"ENABLED={enabled}\nIPV6={ipv6}\nQUEUE=314\nNFQWS={self.bin / 'nfqws2'}\n"
            f"UDP_VOICE_PORTS={voice_ports}\n"
        )
        (self.etc / "zapret.args").write_text("# test stub only\n--lua-desync=stub\n")

    def call(self, *argv, ok=True):
        result = subprocess.run([ZAPRET, *argv], env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return result.stdout.strip()

    def rules(self, family):
        p = self.root / family
        return json.loads(p.read_text()) if p.exists() else {"OUTPUT": [["-j", "ACCEPT"]]}

    def assert_cleanup(self):
        self.assertEqual(self.rules("iptables"), {"OUTPUT": [["-j", "ACCEPT"]]})
        self.assertEqual(self.rules("ip6tables"), {"OUTPUT": [["-j", "ACCEPT"]]})
        self.assertEqual(self.queue.read_text(), "")
        self.assertFalse((self.run / "child").exists())

    def test_inactive_default(self):
        self.configure(enabled=0)
        self.assertEqual(self.call("check"), "disabled")
        self.call("start", ok=False)
        self.assertEqual(self.call("status"), "inactive")
        self.call("stop")
        self.assert_cleanup()

    def test_dual_stack_hooks_repeat_netfilter_refresh_and_stop(self):
        self.configure(ipv6=1)
        self.call("check")
        self.assertTrue((self.root / "profile-checked").exists())
        self.call("start")
        self.call("start")
        self.assertEqual(self.call("status"), "running queue=314 ipv6=1")
        for family in ("iptables", "ip6tables"):
            rules = self.rules(family)
            self.assertEqual(len(rules["OUTPUT"]), 2)
            self.assertEqual(rules["OUTPUT"][1], ["-m", "mark", "--mark", "0x51000/0xff000", "-j", CHAIN])
            self.assertEqual(len(rules[CHAIN]), 4 if family == "iptables" else 3)
            for rule in rules[CHAIN]:
                if "0x100000/0x100000" in rule:
                    self.assertNotIn("--queue-bypass", rule)
                else:
                    self.assertIn("--queue-bypass", rule)
                self.assertIn("0x40000000/0x40000000", rule)
                self.assertIn("1:15", rule)

        self.assertEqual(self.call("diagnostic"), "running queue=314 packets=0")
        (self.root / "ip6tables").unlink()
        self.assertEqual(self.call("status"), "degraded queue=314 ipv6=1")
        self.call("refresh", "ip6tables")
        self.call("refresh", "ip6tables")
        self.assertEqual(len(self.rules("ip6tables")["OUTPUT"]), 2)
        self.assertEqual(self.call("status"), "running queue=314 ipv6=1")
        (self.etc / "zapret.conf").unlink()
        (self.bin / "nfqws2").unlink()
        self.call("stop")
        self.call("stop")
        self.assert_cleanup()

    def test_voice_ports_stay_inside_the_marked_udp_chain(self):
        for invalid in ("0", "443", "442:444", "50100:50000", "65536", "50000,", "1,2,3,4,5,6,7,8"):
            with self.subTest(invalid=invalid):
                self.configure(voice_ports=invalid)
                self.call("check", ok=False)
        self.configure(ipv6=1, voice_ports="50000:50100,51000")
        self.call("start")
        for family in ("iptables", "ip6tables"):
            rules = self.rules(family)
            self.assertEqual(rules["OUTPUT"], [
                ["-j", "ACCEPT"], ["-m", "mark", "--mark", "0x51000/0xff000", "-j", CHAIN],
            ])
            voice_rules = [rule for rule in rules[CHAIN] if "--dports" in rule]
            self.assertEqual(len(voice_rules), 1)
            self.assertEqual(voice_rules[0][:6], ["-p", "udp", "-m", "multiport", "--dports", "50000:50100,51000"])

        self.configure(ipv6=1, voice_ports="52000")
        self.call("start", ok=False)
        (self.root / "iptables").unlink()
        self.call("refresh", "iptables")
        restored_voice = [rule for rule in self.rules("iptables")[CHAIN] if "--dports" in rule]
        self.assertEqual(restored_voice[0][5], "50000:50100,51000")
        self.call("stop")
        self.assert_cleanup()

    def test_staged_strategy_arguments_do_not_replace_persistent_profile(self):
        self.configure()
        default = self.etc / "zapret.args"
        default.write_text("--lua-desync=default-profile-not-selected\n")
        temporary = self.root / "staged.args"
        temporary.write_text("--lua-desync=stub\n")
        self.env["ROUTEHUB_ZAPRET_ARGS"] = str(temporary)
        self.call("check")
        self.call("start")
        self.assertEqual(self.call("status"), "running queue=314 ipv6=0")
        temporary.unlink()
        self.call("stop")
        self.assert_cleanup()
        self.assertEqual(default.read_text(), "--lua-desync=default-profile-not-selected\n")

    def test_missing_kernel_accounting_uses_bounded_managed_profiles(self):
        self.configure(ipv6=1, voice_ports="50000:50100")
        (self.etc / "zapret.args").write_text("--lua-desync=stub\n")
        (self.root / "proc/sys/net/netfilter/nf_conntrack_acct").unlink()
        self.assertEqual(self.call("capability"), "userspace")
        self.call("check", ok=False)
        self.call("start", ok=False)

        temporary = self.root / "managed.args"
        self.env["ROUTEHUB_ZAPRET_ARGS"] = str(temporary)
        self.env["ROUTEHUB_ZAPRET_MANAGED"] = "1"
        self.env["EXPECT_USERSPACE"] = "1"
        temporary.write_text("--filter-tcp=443\n--filter-l7=tls\n--payload=tls_client_hello\n--lua-desync=stub\n")
        self.call("check", ok=False)
        temporary.write_text("--hostlist-domains=youtube.com\n--filter-tcp=443\n--filter-l7=tls\n--payload=tls_client_hello\n--lua-desync=stub\n")
        self.call("check")
        self.call("start")
        self.call("start")
        self.assertEqual(self.call("status"), "running queue=314 ipv6=1 mode=userspace")
        self.assertEqual(self.call("diagnostic"), "running queue=314 packets=0")
        for family in ("iptables", "ip6tables"):
            rules = self.rules(family)
            self.assertEqual(rules["OUTPUT"][-1], ["-m", "mark", "--mark", "0x51000/0xff000", "-j", CHAIN])
            self.assertEqual(len(rules[CHAIN]), 3 if family == "iptables" else 2)
            for rule in rules[CHAIN]:
                self.assertIn("--limit", rule)
                self.assertIn("443", rule)
                self.assertNotIn("connbytes", rule)
                self.assertNotIn("--dports", rule)
                diag = "0x100000/0x100000" in rule
                self.assertEqual("--queue-bypass" in rule, not diag)

        del self.env["ROUTEHUB_ZAPRET_MANAGED"]
        del self.env["ROUTEHUB_ZAPRET_ARGS"]
        (self.root / "iptables").unlink()
        self.call("refresh", "iptables")
        self.assertEqual(self.call("diagnostic"), "running queue=314 packets=0")
        self.call("stop")
        self.assert_cleanup()

    def test_setup_rollback_on_second_family_failure(self):
        self.configure(ipv6=1)
        (self.root / "ipv6-fail").touch()
        self.call("start", ok=False)
        self.assertEqual(self.call("status"), "inactive")
        self.assert_cleanup()

    def test_occupied_queue_and_reserved_arguments(self):
        self.configure()
        self.queue.write_text("314 9999 0 0 0 0 0 1\n")
        self.call("start", ok=False)
        self.assertIn("9999", self.queue.read_text())
        self.queue.write_text("")
        (self.etc / "zapret.args").write_text("--qn=315\n--lua-desync=stub\n")
        self.call("start", ok=False)
        self.assert_cleanup()


if __name__ == "__main__":
    unittest.main()
