import type { ComposerEngine } from "./core.ts";
import type { ComposerEditorAdapter } from "./types.ts";
import { copy } from "./snapshots.ts";

/** For asynchronous editor integrations: a result may be applied only to the draft version it read. */
export function createEditorAdapter(engine: ComposerEngine): ComposerEditorAdapter {
  return {
    capture: () => copy(engine.getSnapshot().state.draft.snapshot),
    apply: (snapshot, expected) => {
      const current = engine.getSnapshot().state.draft;
      if (current.generation !== expected.generation || current.revision !== expected.revision) return Promise.resolve(false);
      return engine.edit(snapshot);
    },
  };
}
