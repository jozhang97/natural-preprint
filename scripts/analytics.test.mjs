import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../src/analytics.ts", import.meta.url), "utf8");
function setup(overrides = {}) {
  const scripts = [];
  const calls = [];
  const context = {
    env: { PROD: true, VITE_GOATCOUNTER_CODE: "test-site" },
    location: { protocol: "https:", hostname: "example.org" },
    navigator: { doNotTrack: "0" },
    window: {},
    document: {
      createElement: () => ({ dataset: {} }),
      head: { append: (script) => scripts.push(script) },
    },
    ...overrides,
  };
  const js = stripTypeScriptTypes(
    source.replaceAll("import.meta.env", "env").replaceAll("export function", "function") +
      "\nglobalThis.api = { initAnalytics, trackUsage };",
  ).replace(/export \{\};?/, "");
  runInNewContext(js, context);
  context.api.initAnalytics();
  return {
    ...context.api, scripts, calls,
    load() {
      context.window.goatcounter.count = (data) => calls.push(JSON.parse(JSON.stringify(data)));
      scripts[0].onload();
    },
    context,
  };
}

test("disabled, development, local, invalid, and Do Not Track configurations load no tracker", () => {
  for (const overrides of [
    { env: { PROD: true, VITE_GOATCOUNTER_CODE: "" } },
    { env: { PROD: false, VITE_GOATCOUNTER_CODE: "test" } },
    { env: { PROD: true, VITE_GOATCOUNTER_CODE: "https://bad.example" } },
    { location: { protocol: "https:", hostname: "localhost" } },
    { location: { protocol: "http:", hostname: "example.org" } },
    { navigator: { doNotTrack: "1" } },
  ]) {
    const app = setup(overrides);
    app.trackUsage("conversion-completed");
    assert.equal(app.scripts.length, 0);
  }
});

test("one pageview and queued events use only fixed payloads", () => {
  const app = setup();
  app.initAnalytics();
  assert.equal(app.scripts.length, 1);
  assert.equal(app.scripts[0].dataset.goatcounter, "https://test-site.goatcounter.com/count");
  app.trackUsage("conversion-completed");
  app.load();
  app.trackUsage("pdf-downloaded");
  assert.deepEqual(app.calls, [
    { path: "/", title: "Natural Preprint", referrer: "" },
    ...["conversion-completed", "pdf-downloaded"].map((event) => ({
      path: event, title: event, referrer: "", event: true, no_session: true,
    })),
  ]);
});

test("blocked scripts and throwing trackers do not break app actions", () => {
  const blocked = setup();
  blocked.scripts[0].onerror();
  assert.doesNotThrow(() => blocked.trackUsage("pdf-downloaded"));
  const broken = setup();
  broken.load();
  broken.context.window.goatcounter.count = () => { throw new Error("offline"); };
  assert.doesNotThrow(() => broken.trackUsage("conversion-completed"));
});
