import { useSyncExternalStore } from "react";
import type { ComposerEngine } from "./core.ts";

/** Subscribe to an explicitly owned engine. Rendering and StrictMode never dispatch messages. */
export function useComposerSubmission(engine: ComposerEngine) {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}
