#!/usr/bin/env python3
"""pass-gate — thin entry point for the gate's verify command.

Usage: python3 gate/pass-gate.py verify <feature-id> [--root DIR] [--layer LAYER]
       python3 gate/pass-gate.py rollback <feature-id> --reason "..." [--root DIR]
       python3 gate/pass-gate.py list [--root DIR]

The implementation lives in gate/harness.py; this file exists so the
frozen name `gate/pass-gate.py` (v3 §2.1) is directly callable. Only
pass-gate (and harness rollback) may write feature_list.json status or
evidence — direct edits by an agent tool are blocked by guard-write.mjs
in Claude Code and rejected by the CI check in tests/gate_ci_check.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402



def _extract_root(argv):
    """Allow --root anywhere (before or after the subcommand)."""
    argv = list(argv)
    root = "."
    out = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--root" and i + 1 < len(argv):
            root = argv[i + 1]
            i += 2
        elif arg.startswith("--root="):
            root = arg.split("=", 1)[1]
            i += 1
        else:
            out.append(arg)
            i += 1
    return root, out

def main() -> int:
    argv = sys.argv[1:]
    # Allow `pass-gate.py <feature-id>` as shorthand for `verify <feature-id>`.
    if argv and not argv[0].startswith("-") and argv[0] not in (
        "init", "verify", "rollback", "list", "check-clean", "handoff", "run",
    ):
        argv = ["verify"] + argv
    root, argv = harness._extract_root(argv)
    parser = harness.build_parser()
    args = parser.parse_args(argv)
    args.root = root
    if getattr(args, "host_command", None) and args.host_command and args.host_command[0] == "--":
        args.host_command = args.host_command[1:]
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
