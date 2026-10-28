#!/usr/bin/env python3
"""harness — the agent-harness gate CLI (v3 Phase 1).

Frozen command surface (v3 §2.2):
    harness init <dir>              generate the four-piece set and run VERIFY
    harness verify <feature-id>     run a feature's verification command;
                                    only on exit 0 does the feature turn
                                    `passing` with evidence written
    harness check-clean             five-dimension session-exit check
    harness handoff                 generate a handoff draft from git,
                                    feature_list and the breakpoint file
    harness run --worktree <name> -- <command...>
                                    run a host command in an isolated git
                                    worktree, then check-clean there;
                                    never auto-merges (Phase 1 safety rule)

This module is deliberately deterministic and host-agnostic: standard
library only, no model calls, no task orchestration, no loop/graph.
Comet is an optional adapter (see gate/adapters/comet.md), not a
dependency of this CLI.

State rules (v3 §5, 1.1–1.2):
- feature_list.json: {"version": 1, "features": [...]}; each feature has
  id, priority, area, title, user_visible_behavior, status, verification,
  evidence, notes. Status is one of not_started, in_progress, blocked,
  passing. At most one feature may be in_progress at a time.
- verification must be an executable command. Evidence must contain
  command, exit_code, ran_at and output_summary. A `passing` feature
  without complete evidence is invalid, not passing.
- `passing` is irreversible by editing: only `harness rollback` (with a
  reason) or a failed re-verification by pass-gate itself may move a
  feature back, and both are logged.
- Every state transition, verification run, rollback and Stop-hook
  override is appended to gate/events.jsonl (in the target project:
  <root>/gate/events.jsonl). Events carry summaries only — never full
  command output, never secrets, never absolute machine paths.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

STATUSES = ("not_started", "in_progress", "blocked", "passing")
LAYERS = (
    "task_spec",
    "context_supply",
    "execution_environment",
    "verification_feedback",
    "state_management",
    "unclassified",
)
FEATURE_FIELDS = (
    "id",
    "priority",
    "area",
    "title",
    "user_visible_behavior",
    "status",
    "verification",
    "evidence",
    "notes",
)
ROOT = Path(__file__).resolve().parent.parent


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _events_path(root: Path) -> Path:
    return root / "gate" / "events.jsonl"


def _log_event(root: Path, event: str, feature_id: str, actor: str, detail: str) -> None:
    path = _events_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": _now(),
        "event": event,
        "feature_id": feature_id,
        "actor": actor,
        "detail": detail[:500],
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def _feature_list_path(root: Path) -> Path:
    return root / "feature_list.json"


def load_features(root: Path) -> dict:
    path = _feature_list_path(root)
    if not path.exists():
        raise SystemExit(f"feature_list.json not found in {root} (run: harness init <dir>)")
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        data = {"version": 1, "features": data}
    return data


def save_features(root: Path, data: dict) -> None:
    _feature_list_path(root).write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def validate(data: dict) -> list[str]:
    """Return a list of validation problems (empty = valid)."""
    problems: list[str] = []
    features = data.get("features", [])
    if not isinstance(features, list):
        return ["features must be a list"]
    seen: set[str] = set()
    in_progress = 0
    for feat in features:
        if not isinstance(feat, dict):
            problems.append("feature is not an object")
            continue
        for field in FEATURE_FIELDS:
            if field not in feat:
                problems.append(f"{feat.get('id', '?')}: missing field {field}")
        fid = feat.get("id", "?")
        if fid in seen:
            problems.append(f"duplicate feature id: {fid}")
        seen.add(fid)
        if feat.get("status") not in STATUSES:
            problems.append(f"{fid}: invalid status {feat.get('status')!r}")
        if feat.get("status") == "in_progress":
            in_progress += 1
        if not feat.get("verification"):
            problems.append(f"{fid}: verification must be an executable command")
        if feat.get("status") == "passing":
            ev = feat.get("evidence") or {}
            for field in ("command", "exit_code", "ran_at", "output_summary"):
                if field not in ev:
                    problems.append(f"{fid}: passing without evidence.{field}")
            if ev.get("exit_code") != 0:
                problems.append(f"{fid}: passing evidence has non-zero exit_code")
            if ev.get("command") and ev["command"] != feat.get("verification"):
                problems.append(f"{fid}: evidence.command does not match verification")
    if in_progress > 1:
        problems.append(f"WIP violation: {in_progress} features in_progress (max 1)")
    return problems


def _find(data: dict, feature_id: str) -> dict:
    for feat in data.get("features", []):
        if feat.get("id") == feature_id:
            return feat
    raise SystemExit(f"unknown feature id: {feature_id}")


def _run_verification(root: Path, command: str, timeout: int = 300) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            command, shell=True, cwd=root, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
        output = (proc.stdout + proc.stderr).strip()
        return proc.returncode, output[:2000]
    except subprocess.TimeoutExpired:
        return 124, f"verification timed out after {timeout}s"


def cmd_verify(args) -> int:
    root = Path(args.root).resolve()
    data = load_features(root)
    problems = validate(data)
    # A passing-without-evidence item is invalid, but verifying other
    # items must still be possible; only block verification of that item.
    feat = _find(data, args.feature)
    if feat["status"] == "passing" and any(
        p.startswith(f"{feat['id']}: passing") for p in problems
    ):
        print(f"REFUSED: {feat['id']} is marked passing but its evidence is invalid; "
              f"rollback it first with a reason.", file=sys.stderr)
        return 2
    was_passing = feat["status"] == "passing"
    code, output = _run_verification(root, feat["verification"], timeout=args.timeout)
    if code == 0:
        feat["evidence"] = {
            "command": feat["verification"],
            "exit_code": 0,
            "ran_at": _now(),
            "output_summary": output[-1000:] or "(no output)",
        }
        feat["status"] = "passing"
        save_features(root, data)
        _log_event(root, "status_transition", feat["id"], "pass-gate",
                    f"{feat['status']} via verification exit 0")
        print(f"PASS: {feat['id']} -> passing (evidence written)")
        return 0
    # Failure: never fabricate a pass. A previously-passing feature that
    # no longer verifies is moved back by the gate itself (system action).
    if was_passing:
        feat["status"] = "in_progress"
        save_features(root, data)
        _log_event(root, "verification_regression", feat["id"], "pass-gate",
                    f"re-verification failed (exit {code}); moved back to in_progress; layer={args.layer}")
    else:
        _log_event(root, "verification_failed", feat["id"], "pass-gate",
                    f"exit {code}; layer={args.layer}")
    print(f"FAIL: {feat['id']} stays {feat['status']} (verification exit {code})", file=sys.stderr)
    print(f"  layer: {args.layer} (supply --layer after investigation; see diagnostic layers in the docstring)")
    print(f"  output (truncated): {output[-500:]}", file=sys.stderr)
    return 1


def cmd_rollback(args) -> int:
    root = Path(args.root).resolve()
    data = load_features(root)
    feat = _find(data, args.feature)
    if feat["status"] != "passing":
        print(f"REFUSED: {feat['id']} is {feat['status']}, only passing features can be rolled back.", file=sys.stderr)
        return 2
    if not args.reason:
        print("REFUSED: rollback requires --reason (evidence invalidation reason).", file=sys.stderr)
        return 2
    feat["status"] = "in_progress"
    feat["evidence"] = {}
    save_features(root, data)
    _log_event(root, "human_rollback", feat["id"], "human", args.reason)
    print(f"ROLLBACK: {feat['id']} -> in_progress (reason logged)")
    return 0


def cmd_list(args) -> int:
    root = Path(args.root).resolve()
    data = load_features(root)
    problems = validate(data)
    for feat in data.get("features", []):
        print(f"{feat['id']:12} {feat['status']:12} {feat.get('title','')}")
    if problems:
        print("\nValidation problems:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    return 0


def cmd_check_clean(args) -> int:
    """Five-dimension session-exit check (v3 §5, 1.5).

    Dimensions: (1) build, (2) test/verification, (3) progress recorded,
    (4) temp artefacts cleaned, (5) standard startup path usable.
    A dimension with no evidence is SKIP, never silently PASS.
    """
    root = Path(args.root).resolve()
    results: list[tuple[str, str, str]] = []
    try:
        data = load_features(root)
        problems = validate(data)
    except SystemExit as exc:
        print(f"FAIL progress: {exc}")
        return 1
    init_sh = root / "init.sh"
    if init_sh.exists():
        proc = subprocess.run(["bash", "-n", str(init_sh)], capture_output=True, text=True)
        results.append(("build", "PASS" if proc.returncode == 0 else "FAIL",
                        "init.sh syntax ok" if proc.returncode == 0 else proc.stderr[:200]))
    else:
        results.append(("build", "SKIP", "no init.sh present"))
    passing_bad = [p for p in problems if ": passing" in p]
    results.append(("test", "FAIL" if passing_bad else "PASS",
                    "; ".join(passing_bad) or "all passing features have evidence"))
    session_state = root / "SESSION_STATE.md"
    if not session_state.exists() or not session_state.read_text(encoding="utf-8", errors="ignore").strip():
        results.append(("progress", "FAIL", "SESSION_STATE.md missing or empty"))
    elif "<" in session_state.read_text(encoding="utf-8", errors="ignore") and (
        "what this session" in session_state.read_text(encoding="utf-8", errors="ignore")
        or "本会话要完成" in session_state.read_text(encoding="utf-8", errors="ignore")):
        # Template placeholders are not a breakpoint: a new session cannot
        # resume from them. This FAIL is what the Phase 1 handoff test
        # caught on the first dogfood run.
        results.append(("progress", "FAIL", "SESSION_STATE.md still contains unfilled template placeholders"))
    else:
        results.append(("progress", "PASS", "SESSION_STATE.md present and non-empty; feature_list valid"
                        if not problems else f"SESSION_STATE present but feature_list problems: {problems}"))
    temp_hits: list[str] = []
    for path in root.rglob("*"):
        if ".git" in path.parts or "node_modules" in path.parts:
            continue
        if path.is_dir() and path.name == "scratch":
            temp_hits.append(str(path.relative_to(root)))
        if ".bak-" in path.name:
            temp_hits.append(str(path.relative_to(root)))
    results.append(("temp", "FAIL" if temp_hits else "PASS",
                    f"temp artefacts: {temp_hits}" if temp_hits else "no scratch/ or *.bak-* found"))
    if init_sh.exists():
        text = init_sh.read_text(encoding="utf-8", errors="ignore")
        results.append(("startup", "PASS" if "START" in text else "FAIL",
                        "init.sh present" if "START" in text else "init.sh has no START command"))
    else:
        results.append(("startup", "FAIL", "init.sh missing (four-piece set incomplete)"))
    failed = False
    for name, status, detail in results:
        print(f"{name:10} {status:5} {detail}")
        if status == "FAIL":
            failed = True
    return 1 if failed else 0


STAGES = ("static", "runtime", "system")


def _termination_path(root: Path) -> Path:
    return root / "gate" / "termination.json"


def _load_termination(root: Path) -> dict:
    path = _termination_path(root)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _save_termination(root: Path, state: dict) -> None:
    path = _termination_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def cmd_terminate(args) -> int:
    """Three-layer termination (v3 Phase 2.4): static -> runtime -> system.

    A feature may not skip a layer: requesting runtime without static,
    or system without runtime, is refused (exit 2) and logged to
    gate/events.jsonl as termination_skip_refused. This is the
    pass-gate integration — termination is not a separate approval path.
    - static: feature_list validates and init.sh (if present) parses.
    - runtime: the feature's verification command runs and exits 0;
      evidence is written, but status does not yet become passing.
    - system: harness check-clean passes; only then does the feature
      become passing, with the runtime evidence attached.
    """
    import types as _types

    root = Path(args.root).resolve()
    data = load_features(root)
    feat = _find(data, args.feature)
    state = _load_termination(root)
    done = state.get(feat["id"], {})
    stage = args.stage
    prerequisites = {"static": [], "runtime": ["static"], "system": ["static", "runtime"]}
    missing = [p for p in prerequisites[stage] if not done.get(p)]
    if missing:
        _log_event(root, "termination_skip_refused", feat["id"], "pass-gate",
                    f"requested {stage} without {missing}")
        print(f"REFUSED: cannot run {stage} before {missing} for {feat['id']} "
              f"(three-layer order is static -> runtime -> system)", file=sys.stderr)
        return 2
    if stage == "static":
        problems = validate(data)
        init_sh = root / "init.sh"
        if init_sh.exists():
            proc = subprocess.run(["bash", "-n", str(init_sh)], capture_output=True, text=True)
            if proc.returncode != 0:
                problems.append(f"init.sh syntax failed: {proc.stderr[:200]}")
        if problems:
            _log_event(root, "termination_failed", feat["id"], "pass-gate",
                        f"static failed: {problems[:3]}")
            print(f"FAIL static: {problems}", file=sys.stderr)
            return 1
        done["static"] = True
    elif stage == "runtime":
        code, output = _run_verification(root, feat["verification"], timeout=args.timeout)
        if code != 0:
            _log_event(root, "verification_failed", feat["id"], "pass-gate",
                        f"termination runtime failed (exit {code})")
            print(f"FAIL runtime: {feat['id']} verification exit {code}", file=sys.stderr)
            print(f"  output (truncated): {output[-500:]}", file=sys.stderr)
            return 1
        feat["evidence"] = {
            "command": feat["verification"],
            "exit_code": 0,
            "ran_at": _now(),
            "output_summary": output[-1000:] or "(no output)",
        }
        save_features(root, data)
        done["runtime"] = True
    else:  # system
        clean = cmd_check_clean(_types.SimpleNamespace(root=str(root)))
        if clean != 0:
            _log_event(root, "termination_failed", feat["id"], "pass-gate",
                        "system failed: check-clean did not pass")
            print(f"FAIL system: check-clean did not pass for {feat['id']}", file=sys.stderr)
            return 1
        feat["status"] = "passing"
        save_features(root, data)
        done["system"] = True
        _log_event(root, "status_transition", feat["id"], "pass-gate",
                    "passing via three-layer termination (static+runtime+system)")
    state[feat["id"]] = done
    _save_termination(root, state)
    print(f"TERMINATE {stage}: {feat['id']} OK (stages done: "
          f"{[s for s in STAGES if done.get(s)]})")
    return 0


def cmd_handoff(args) -> int:
    root = Path(args.root).resolve()
    data = load_features(root)
    features = data.get("features", [])
    in_progress = [f for f in features if f["status"] == "in_progress"]
    blocked = [f for f in features if f["status"] == "blocked"]
    passing = [f for f in features if f["status"] == "passing"]
    next_item = in_progress[0] if in_progress else next(
        (f for f in features if f["status"] == "not_started"), None)
    git_log = ""
    proc = subprocess.run(["git", "log", "--oneline", "-10"], cwd=root,
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode == 0:
        git_log = proc.stdout.strip()
    events = ""
    events_path = _events_path(root)
    if events_path.exists():
        events = "\n".join(events_path.read_text(encoding="utf-8").strip().splitlines()[-10:])
    lines = [
        "# Handoff draft (generated by harness handoff — review before use)",
        "",
        f"- Verified: {len(passing)} passing; in progress: {len(in_progress)}; blocked: {len(blocked)}",
        f"- In progress: {', '.join(f['id'] for f in in_progress) or 'none'}",
        f"- Blocked: {', '.join(f['id'] for f in blocked) or 'none'}",
        f"- Next: {next_item['id'] + ' — ' + next_item['title'] if next_item else 'none'}",
        "- Do not touch (until verified): feature_list.json status fields — only pass-gate may write them.",
        "",
        "## Recent commits",
        git_log or "(not a git repository or no commits)",
        "",
        "## Recent gate events",
        events or "(no events yet)",
    ]
    text = "\n".join(lines) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"handoff written to {args.out}")
    else:
        print(text)
    return 0


def cmd_init(args) -> int:
    target = Path(args.target).resolve()
    target.mkdir(parents=True, exist_ok=True)
    template_dir = ROOT / "templates"
    # AGENTS.md (short, gate-aware; full distributable templates stay in templates/agents/)
    (target / "AGENTS.md").write_text(
        "# AGENTS.md (gate project)\n\n"
        "This project uses the agent-harness gate (`gate/`). Rules:\n\n"
        "- `feature_list.json` is the only task-state source. Never edit its\n"
        "  `status` or `evidence` fields by hand — only `harness verify` and\n"
        "  `harness rollback --reason ...` may write them.\n"
        "- A feature is done only when its verification command exits 0 and\n"
        "  pass-gate has written evidence. A claim without evidence is not done.\n"
        "- At most one feature may be `in_progress` at a time.\n"
        "- Before stopping, run `harness check-clean` and fix every FAIL.\n"
        "- `SESSION_STATE.md` is the breakpoint (one page max): current goal,\n"
        "  in-progress feature link, next step, blockers, last verification.\n",
        encoding="utf-8",
    )
    feature_template = template_dir / "feature_list.template.json"
    if feature_template.exists():
        (target / "feature_list.json").write_text(
            feature_template.read_text(encoding="utf-8"), encoding="utf-8")
    else:
        (target / "feature_list.json").write_text(
            json.dumps({"version": 1, "features": []}, indent=2) + "\n", encoding="utf-8")
    session_template = template_dir / "SESSION_STATE.template.md"
    session_text = (session_template.read_text(encoding="utf-8")
                    if session_template.exists() else "# SESSION_STATE\n\n- Current goal: \n- In progress: \n- Next step: \n- Blockers: \n- Last verification: \n")
    (target / "SESSION_STATE.md").write_text(session_text, encoding="utf-8")
    init_template = ROOT / "gate" / "init.template.sh"
    init_text = init_template.read_text(encoding="utf-8") if init_template.exists() else (
        "#!/bin/sh\nINSTALL_CMD=true\nVERIFY_CMD='test -f feature_list.json'\nSTART_CMD='echo see AGENTS.md'\n")
    (target / "init.sh").write_text(init_text, encoding="utf-8")
    os.chmod(target / "init.sh", 0o755)
    # Actually run the VERIFY segment: replace placeholders first is a
    # project responsibility, so init fails loudly if a placeholder remains.
    if "<" in init_text and ">" in init_text and ("<INSTALL" in init_text or "<VERIFY" in init_text or "<START" in init_text):
        print("INIT FAILED: init.sh still contains placeholders; fill INSTALL/VERIFY/START with real commands.", file=sys.stderr)
        return 1
    # Run init.sh in the target directory: its VERIFY/START commands are
    # relative to the target project, not to the harness checkout.
    proc = subprocess.run(["bash", str(target / "init.sh")], cwd=target,
                          capture_output=True, text=True)
    print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, file=sys.stderr, end="")
    if proc.returncode != 0:
        print("INIT FAILED: VERIFY segment of init.sh did not pass.", file=sys.stderr)
        return 1
    print(f"INIT OK: four-piece set generated in {target} and VERIFY passed")
    return 0


def cmd_run(args) -> int:
    """Worktree wrapper (Phase 1): non-interactive host commands only."""
    root = Path(args.root).resolve()
    if not args.host_command:
        print("REFUSED: harness run requires a host command after --", file=sys.stderr)
        return 2
    worktree_dir = root / ".worktrees" / args.worktree
    if worktree_dir.exists():
        print(f"REFUSED: worktree already exists: {worktree_dir} (remove it or pick another name)", file=sys.stderr)
        return 2
    proc = subprocess.run(["git", "worktree", "add", str(worktree_dir)], cwd=root,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"worktree creation failed: {proc.stdout} {proc.stderr}", file=sys.stderr)
        return 1
    print(f"worktree created: {worktree_dir}")
    try:
        run = subprocess.run(args.host_command, cwd=worktree_dir)
        if run.returncode != 0:
            print(f"host command failed (exit {run.returncode}); worktree left in place for inspection; NOT merged.", file=sys.stderr)
            return run.returncode
        # Check-clean inside the worktree (feature_list may not exist there
        # for non-gate projects; in that case report and do not merge blindly).
        if (worktree_dir / "feature_list.json").exists():
            clean = subprocess.run([sys.executable, str(ROOT / "gate" / "harness.py"),
                                    "--root", str(worktree_dir), "check-clean"])
            if clean.returncode != 0:
                print("check-clean failed in worktree; NOT merged. Fix, re-verify, then merge manually.", file=sys.stderr)
                return 1
        print(f"OK in worktree {worktree_dir}. Phase 1 does NOT auto-merge.")
        print(f"To merge manually after review: git merge --no-ff <branch-from-worktree> (see git worktree list)")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"harness run failed: {exc}", file=sys.stderr)
        return 1



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

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness", description="agent-harness gate CLI (v3 Phase 1)")
    parser.add_argument("--root", default=".", help="target project root (default: .)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("init", help="generate the four-piece set")
    p.add_argument("target", help="target project directory")
    p.set_defaults(func=cmd_init)
    p = sub.add_parser("verify", help="run a feature's verification; pass only on exit 0")
    p.add_argument("feature", help="feature id")
    p.add_argument("--layer", default="unclassified", choices=LAYERS, help="diagnostic layer for failures")
    p.add_argument("--timeout", type=int, default=300, help="verification timeout in seconds")
    p.set_defaults(func=cmd_verify)
    p = sub.add_parser("rollback", help="move a passing feature back, with a reason")
    p.add_argument("feature", help="feature id")
    p.add_argument("--reason", required=True, help="why the passing evidence is invalid")
    p.set_defaults(func=cmd_rollback)
    p = sub.add_parser("list", help="list features and validate")
    p.set_defaults(func=cmd_list)
    p = sub.add_parser("check-clean", help="five-dimension session-exit check")
    p.set_defaults(func=cmd_check_clean)
    p = sub.add_parser("terminate", help="three-layer termination: static -> runtime -> system, no skipping")
    p.add_argument("feature", help="feature id")
    p.add_argument("--stage", required=True, choices=STAGES, help="termination layer")
    p.add_argument("--timeout", type=int, default=300, help="verification timeout in seconds (runtime stage)")
    p.set_defaults(func=cmd_terminate)
    p = sub.add_parser("handoff", help="generate a handoff draft")
    p.add_argument("--out", default=None, help="write handoff to file instead of stdout")
    p.set_defaults(func=cmd_handoff)
    p = sub.add_parser("run", help="run a host command in an isolated git worktree")
    p.add_argument("--worktree", required=True, help="worktree name under .worktrees/")
    p.add_argument("host_command", nargs=argparse.REMAINDER, help="host command after --")
    p.set_defaults(func=cmd_run)
    return parser


def main(argv=None) -> int:
    root, argv = _extract_root(argv if argv is not None else sys.argv[1:])
    parser = build_parser()
    args = parser.parse_args(argv)
    args.root = root
    # argparse REMAINDER keeps a leading '--' element; strip it.
    if getattr(args, "host_command", None) and args.host_command[0] == "--":
        args.host_command = args.host_command[1:]
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
