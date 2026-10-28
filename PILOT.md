# Second pilot: v3 gate in muse-ai-Desktop (D2)

Branch: `pilot/v3-gate` only. Never commit to or push `main` from
pilot work. Releases are draft and tag-triggered, so pilot-branch
work cannot reach users.

## Verification command (pinned at pilot start)

Tier 1 — per-task gate (fast, no dependencies):
```
node --check main.js && node --check preload-chat-export.js \
  && node --check preload-lock.js && node --check preload-settings.js \
  && node --test tests/*.test.js
```

Tier 2 — release parity (before pilot close, and whenever Tier 1
passes on a task touching packaging):
```
npm ci && npm run dist:linux -- --publish never
```
Tier 2 mirrors `.github/workflows/release.yml` (ubuntu-latest job).
If Tier 2 cannot run in this VM, that is recorded as a pilot
finding, not papered over; the release workflow remains the
authoritative release check.

## Notes from setup

- No test script or test files existed at pilot start (package.json
  has only dist/start scripts). Adding a test suite is therefore
  itself pilot task P1, per D2.
- main.js executes Electron app code at load (app.setName,
  requestSingleInstanceLock), so it cannot be required in plain
  node. Pure helpers must be extracted into a module to be tested.
- Gate tooling in gate/ (harness.py, pass-gate.py, schema) is
  copied from agent-harness v3-yunyi for pilot use; it is not a
  vendored dependency and must not be edited here to fix upstream.

## Pilot finding 1 (gate layout)

harness.py runs a feature's verification with cwd = its --root.
Putting feature_list.json under gate/ therefore breaks relative
verification commands (it tried gate/main.js). The working layout
is: feature_list.json at the project root, tooling in gate/,
harness run from the project root. This is a pilot usability
finding for the gate docs, not a code change to the gate itself.

## Pilot finding 2 (Tier 2 result, 2026-10-28)

`npm run dist:linux -- --publish never` passed in this VM
(exit 0): Muse-1.5.22.AppImage and muse-desktop_1.5.22_amd64.deb
both produced. Tier 2 is therefore runnable here, not only in
CI; dist/ itself stays untracked (build output, not committed).
