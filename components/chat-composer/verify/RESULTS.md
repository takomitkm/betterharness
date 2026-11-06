# Verification results

Date: 2026-11-07. New implementation on local branch `feat/reliable-chat-composer`, based on `c098a0ffae57105406ee8254b823cdff63f4ce75` plus the working-tree changes. This is not a claim about upstream ZCode or its installed application.

The final candidate was copied to an isolated Windows school-server directory with a SHA-256 manifest. Every one of the 26 transferred source/dependency files matched before execution. Dependencies were installed only there.

## Final complete gate

Executed consecutively, with failure propagation enabled:

```sh
npm ci --registry=https://registry.npmmirror.com --no-audit --no-fund
npm run typecheck
npm run build:demo
npm test
npm run test:browser
npm run test:mutations
```

Overall exit status: **0**.

| Gate | Actual result |
| --- | --- |
| Locked clean installation | 72 packages installed; success |
| TypeScript | 0 errors |
| Demo build | success |
| Core / recovery / adapters / durability | 25 passed, 0 failed, 0 skipped |
| Real browser suite | 21 passed, 0 failed, 0 skipped |
| Deliberately broken production behaviors | 14/14 detected by contract-test failures |

The core tests took about 0.21 seconds and the browser suite about 11 seconds in the final run. These are observed run times, not a performance guarantee.

Environment: Windows, Node 24.9.0, React/React DOM 19.3.1, Lexical/@lexical/react 0.36.2, TypeScript 5.9.3, playwright-core 1.65.0, installed Microsoft Edge in headless mode. Exact dependency versions and integrity are retained in `package-lock.json`.

## What the browser suite actually exercised

- Real React StrictMode, controlled textarea and actual Lexical editor with a custom mention token.
- Real IndexedDB writes, Blob persistence and compare-and-swap conflicts across two tabs.
- A loopback HTTP host that persists receipts, enforces message identity and checks duplicate/conflicting payloads.
- A lost HTTP reply after admission, plus receipt lookup without a new logical execution.
- Reload and an actual CDP `Page.crash` event. The crashed page was closed and a fresh renderer opened in the same browser storage context. A remained unknown, B survived, and receipt lookup confirmed A without another execution.
- Local write failure before admission and receipt-save failure after host admission.
- FIFO turn transitions, steer, none, queue recovery and an empty successor draft.
- Rich document + file bytes restored together, external references retained during editing, and Undo prevented from resurrecting a submitted message.

## Red/green evidence

The initial implementation contracts were written before the core. The following later concrete defects were then reproduced against real implemented code, fixed, and rerun:

- FM17: late admission reactivated an already finished turn → now remains finished.
- FM18: close left an uncooperative lookup waiting for its timeout → now resolves promptly.
- FM19: cyclic document metadata overflowed recursive processing → rejected before draft replacement.
- FM24: sending-marker write failure left a saved queue stuck after recovery → local retry restarts eligible delivery.
- FM25: a stale unknown lookup downgraded an explicit rejection → definitive result remains definitive.
- B15: typing in Lexical deleted externally owned references → preserves non-mention references.
- B16: Undo restored already submitted A into the empty successor draft → history is isolated at ownership changes.

The mutation runner additionally required a green baseline, then used temporary source copies to break 14 actual production behaviors. All 14 produced the intended contract-test failures. Import failures, parser errors, zero/multiple mutation targets and timeouts are explicitly rejected as invalid calibration.

During development, the CAS mutation initially matched both initialization and commit guards. The runner stopped rather than counting that as success; its target was narrowed to the commit guard before the final passing run.

## Tested source fingerprints

```text
6aa3a7edf3477c253cc6f11572cb039c205bd0c246ba567492a8c27ad3b5b8fa  core.ts
4e6f59d27e06e4f13bdfb2b90af45be50e42a831fa833824708cf272aa7bef4a  store.ts
deec3e30d6dd0eb922bc3aa0e72e5a01d00aee132d5e4d2154e985003c9bf417  LexicalEditor.tsx
019dfb2c717ecd499754c598fa8ef2bda528c1a929aa464b3305e72ee567d27c  ChatComposer.tsx
820199fdf3f8a21adb404b9e8930263acf8e0c24ed4c35481d43d28cfe299571  verify/demo-playwright.mjs
270b0e2573486eaf205cc8b6a4ebc6125df8c38f60a11e9d6778ef3e6911a42e  verify/mutations.mjs
```

This results document was added after the final executable gate; the production source fingerprints above were unchanged.

## Limits

The tests did not exercise a real LLM provider, physical disk loss, complete profile deletion, OS-wide OOM, native Windows IME candidate UI, or visual acceptance. Their scope and the required production-host idempotency/receipt contract are explicit in `FAILURE-MODES.md` and the component README. No production dependency or development environment was installed on the user's local machine.
