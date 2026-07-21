import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { assertRouteManifestMatchesPackageV1 } from "@wechat2all/route-sdk";

import { routePackage } from "../src/package.js";

test("Claude static manifest matches its executable protocol export", async () => {
  const raw = await fs.readFile(new URL("../weconnect.route.json", import.meta.url), "utf-8");
  assert.doesNotThrow(() => {
    assertRouteManifestMatchesPackageV1(JSON.parse(raw), routePackage);
  });
});
