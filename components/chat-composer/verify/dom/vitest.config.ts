import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", include: ["chat-composer/verify/chat-composer.dom.test.tsx"] },
});
