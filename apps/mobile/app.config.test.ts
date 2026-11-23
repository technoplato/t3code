import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  // The config copies these back onto process.env, where an absent value would become "undefined".
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    ...(process.env.T3CODE_IOS_TEAM_ID
      ? { T3CODE_IOS_TEAM_ID: process.env.T3CODE_IOS_TEAM_ID }
      : {}),
    ...(process.env.T3CODE_IOS_BUNDLE_ID
      ? { T3CODE_IOS_BUNDLE_ID: process.env.T3CODE_IOS_BUNDLE_ID }
      : {}),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("builds the whole app under another paid team and bundle identifier", async () => {
  vi.stubEnv("T3CODE_IOS_TEAM_ID", "ABCDE12345");
  vi.stubEnv("T3CODE_IOS_BUNDLE_ID", "com.example.t3code");
  const config = await loadConfig("production");
  expect(config.ios?.appleTeamId).toBe("ABCDE12345");
  expect(config.ios?.bundleIdentifier).toBe("com.example.t3code");
  // A paid team signs what a Personal Team cannot: the widget and share extensions stay in.
  const plugins = JSON.stringify(config.plugins);
  expect(plugins).toContain("com.example.t3code.widgets");
  expect(plugins).toContain("group.com.example.t3code");
  expect(plugins).not.toContain("withoutIosPersonalTeamCapabilities");
  // Android keeps the variant's package.
  expect(config.android?.package).toBe("com.t3tools.t3code");
});

it.each([
  ["ABCDE12345", undefined],
  [undefined, "com.example.t3code"],
  ["abc", "com.example.t3code"],
  ["ABCDE12345", "t3code"],
])("rejects T3CODE_IOS_TEAM_ID=%j with T3CODE_IOS_BUNDLE_ID=%j", async (team, bundle) => {
  vi.stubEnv("T3CODE_IOS_TEAM_ID", team);
  vi.stubEnv("T3CODE_IOS_BUNDLE_ID", bundle);
  await expect(loadConfig("production")).rejects.toThrow("T3CODE_IOS_TEAM_ID");
});
