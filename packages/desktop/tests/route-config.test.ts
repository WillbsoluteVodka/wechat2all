import assert from "node:assert/strict";
import test from "node:test";

import {
  commitRouteConfigDraft,
  routeConfigControlKind,
  routeConfigTextValue,
  routeSecretConfigStatus,
} from "../src/route-config.js";

test("legacy choice controls remain select controls", () => {
  assert.equal(routeConfigControlKind({
    configKey: "sample",
    field: "mode",
    label: "Mode",
    values: [{ value: "one", label: "One" }],
  }), "select");
  assert.equal(routeConfigControlKind({
    configKey: "sample",
    field: "emptyMode",
    label: "Empty mode",
    values: [],
  }), "select");
});

test("input controls normalize only display-safe primitive values", () => {
  assert.equal(routeConfigTextValue("hello"), "hello");
  assert.equal(routeConfigTextValue(42), "42");
  assert.equal(routeConfigTextValue({ configured: true, masked: "sk-...1234" }), "");
});

test("secret snapshots expose status without producing an input value", () => {
  assert.deepEqual(routeSecretConfigStatus({
    configured: true,
    masked: "sk-...1234",
  }), {
    configured: true,
    masked: "sk-...1234",
  });
  assert.equal(routeConfigTextValue({
    configured: true,
    masked: "sk-...1234",
  }), "");
});

test("successful config commits apply the requested draft transition", async () => {
  let completed = false;
  const result = await commitRouteConfigDraft({
    currentDraft: "new-secret",
    savedDraft: "",
    commit: async () => {
      await Promise.resolve();
      completed = true;
      return true;
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(result, { saved: true, draft: "" });
});

test("failed config commits preserve the draft, including rejected commits", async () => {
  assert.deepEqual(await commitRouteConfigDraft({
    currentDraft: "keep-this-secret",
    savedDraft: "",
    commit: async () => false,
  }), {
    saved: false,
    draft: "keep-this-secret",
  });

  assert.deepEqual(await commitRouteConfigDraft({
    currentDraft: "keep-this-value",
    savedDraft: "",
    commit: async () => {
      throw new Error("save failed");
    },
  }), {
    saved: false,
    draft: "keep-this-value",
  });
});
