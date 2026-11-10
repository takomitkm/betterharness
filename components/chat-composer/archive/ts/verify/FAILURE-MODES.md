# Failure modes and acceptance oracles

All tests call the new production implementation. `FM*` are Node built-in tests; `B*` are real React/IndexedDB/HTTP browser tests. The test directory contains no React hook shim.

| Failure | Injection / trigger | Observer and legal result |
| --- | --- | --- |
| Repeated admission / held Enter | Same-task submit, pending UI second Enter, repeat keydown | FM01/FM16, B01/B12: one logical message, empty successor editor, no phantom newline |
| Old callback modifies newer input | Held receipt; successor text B / same A / whitespace | FM02/FM04, B02: new draft generation, exact text and persistence survive |
| Reply lost after server admission | Throw, timeout, dropped real HTTP response | FM03/FM04/FM09, B03/B04: unknown is retained, no automatic retry or restoration; lookup confirms original ID |
| Duplicate or conflicting payload under an admitted ID | Real repeated HTTP send | B19: same payload reuses its receipt, changed payload stays unconfirmed, admission count remains one |
| Failure before durable handoff | Store write throws / resource error | FM06/FM07, B10/B11: no partial handoff, no network dispatch, original payload remains |
| Receipt write fails after admission | One-shot error on receipt commit | FM23, B17: received result remains retryable locally; transport count stays one; B survives |
| Sending marker write fails | One-shot error on queued → sending transaction | FM24: record stays queued; local retry restarts delivery after storage recovers |
| Recovery overwrites edits | Explicit rejection, occupied / whitespace draft | FM05, B05: failed record remains separate; explicit recovery cannot overwrite new input |
| Payload loses structure or bytes | Attachment-only, mention + Blob, queued snapshots | FM08/FM11, B06/B07/B08: complete payload, no duplicate attachment submission; reload retains bytes and token nodes |
| Stale editor integration result | Old generation/revision, including equal text | FM20: version mismatch rejected, no string-equality substitute |
| Queue drains before current turn ends | Two queued messages, correct / stale end events | FM12/FM13, B08/B09: FIFO; one new start per completed turn; steer carries current turn ID |
| Finished turn revived by late receipt | endTurn before delayed admission | FM17: accepted record settles, finished turn stays finished |
| Multiple windows overwrite each other | Two engine instances at the same storage revision | FM14, B13: one writer wins CAS; losing window keeps unsaved local input and reports conflict |
| Wrong or malformed receipt | Cross-scope receipt / invalid turn identity | FM15: remains unknown, no false admission |
| A stale lookup downgrades definitive non-admission | Delay unknown lookup until an explicit rejection arrives | FM25: rejection remains definitive; retry invalidates the previous attempt identity |
| Uncooperative query on close | lookup ignores AbortSignal | FM18: close resolves query promptly and releases timers |
| Corrupt snapshot / storage | Cyclic JSON, unsupported persisted schema | FM19/FM22: reject without replacing valid draft or overwriting original persisted bytes |
| Dropping an unsettled payload | Explicit removal attempt | FM21: unknown/sending/queued records cannot be forgotten |
| Rich editor drops external references | Inject a code-comment reference, then type | B15: only mention-owned references are replaced |
| Undo resurrects an already submitted message | Type A, handoff, Undo in successor Lexical draft | B16: old message cannot return through undo history |
| Renderer process dies | CDP Page.crash on an isolated test page | B18 must observe actual crash event, then reload: A unknown, B intact, lookup confirms without second execution |
| IME / newline confusion | Composition-tagged Enter, actual Shift+Enter, key repeat | FM16, B12: composition does not submit, explicit newline remains a newline |

## Mutation calibration

`npm run test:mutations` first requires the full core baseline to pass. It then copies production sources to an independent temporary directory, changes one behavior, and requires a real contract-test failure. Import/parser errors and a mutation target that matches zero/multiple places are failures of calibration, not successful kills.

The mutations cover retained sent text, late clearing, misclassified unknown results, ignored CAS, unsafe recovery, revived turns, stalled local recovery, cyclic metadata, stale adapter writes, ignored storage schema, lost attachment snapshots, ignored repeat flags, and clearing before durable commit. The checkout is never modified by the mutation runner.

The two Lexical review regressions were also run against the pre-fix production editor in actual Edge: B15 and B16 both failed on their content assertions before the fixes.

## Configuration axes

- Text versus actual Lexical + mention nodes.
- Plain text / whitespace / same-text successor / attachment-only / mixed structured payload.
- queued / sending / accepted / rejected / unknown / recovered renderer.
- Same engine versus independent windows and durable restart.
- queue / steer / none and stale versus current turn identity.
- Normal I/O, one-shot failure, late response, lost response, and interrupted renderer.

## Explicit exclusions

- Physical disk loss, browser-profile deletion, and user-cleared site storage: local IndexedDB is not a backup service.
- Full-machine OOM and hardware corruption: deterministic resource/storage failures and malformed metadata are tested; an OS-killed process is outside recoverable JavaScript exceptions.
- Native Windows IME candidate UI: synthetic composition guards are automated; no claim that OS IME was manually exercised in this run.
- A real model provider's idempotency and receipt retention: the executable loopback fixture verifies the protocol; production hosts must implement the same contract.
- Pixel-perfect rendering: browser tests exercise content, events, focusable controls and persistence; they are not a visual acceptance pass.

Unexpected test skips, unmatched fault gates, unobserved renderer crashes, module-load failures, or missing browsers must fail the relevant verification rather than count as success.
