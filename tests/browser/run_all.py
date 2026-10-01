"""Runs every browser test script in this folder (each one is standalone: prints PASS/FAIL, exits non-zero on failure).

    pip install playwright && python tests/browser/run_all.py        # needs Google Chrome (CI: `playwright install chrome`)
"""
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
scripts = sorted(f for f in glob.glob(os.path.join(HERE, "*.py")) if not os.path.basename(f).startswith(("_", "run_all")))
failed = []
for script in scripts:
    name = os.path.basename(script)
    proc = subprocess.run([sys.executable, script], cwd=HERE, capture_output=True, text=True, timeout=600)
    ok = proc.returncode == 0 and "ALL PASSED" in proc.stdout
    print(f"{'OK  ' if ok else 'FAIL'} {name:14} {proc.stdout.count('PASS ')} checks")
    if not ok:
        failed.append(name)
        print(proc.stdout[-2500:], proc.stderr[-1500:], sep="\n")
print("\nALL BROWSER TESTS PASSED" if not failed else f"\nFAILED: {failed}")
sys.exit(1 if failed else 0)
