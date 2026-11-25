import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";

test("the Vite development proxy preserves the shared Django API path", async () => {
  const path = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
  const resolved = await loadConfigFromFile({ command: "serve", mode: "development" }, path);
  assert.ok(resolved, "the website does not have a development proxy");
  assert.deepEqual(resolved.config.server.proxy["/api/v1"], {
    target: "http://127.0.0.1:8000",
    changeOrigin: false,
  });
});
