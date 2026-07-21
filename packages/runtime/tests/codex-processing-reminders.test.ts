import assert from "node:assert/strict";
import { test } from "node:test";

const codexRouteTestModulePath = ["..", "..", "codex-route", "src", "index.js"].join("/");
const {
  CODEX_PROCESSING_REMINDER_TEXTS,
  createCodexProcessingReminderPicker,
} = await import(codexRouteTestModulePath) as {
  CODEX_PROCESSING_REMINDER_TEXTS: readonly string[];
  createCodexProcessingReminderPicker(random?: () => number): () => string;
};

test("codex processing reminder pool contains 20 unique messages", () => {
  assert.equal(CODEX_PROCESSING_REMINDER_TEXTS.length, 20);
  assert.equal(new Set(CODEX_PROCESSING_REMINDER_TEXTS).size, 20);
  assert.equal(
    CODEX_PROCESSING_REMINDER_TEXTS.every((message) => message.trim().length > 0),
    true,
  );
});

test("codex processing reminder picker avoids consecutive duplicates", () => {
  const pickReminder = createCodexProcessingReminderPicker(() => 0);
  const messages = [pickReminder(), pickReminder(), pickReminder(), pickReminder()];

  for (let index = 1; index < messages.length; index += 1) {
    assert.notEqual(messages[index], messages[index - 1]);
  }
});
