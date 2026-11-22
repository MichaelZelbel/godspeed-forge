// The values the moved helpers' tests run with. They are the values of one real installation, which the
// tests use as plain fixtures; no shipped file carries any of them. Importing this file also puts the same
// values into the environment (FORGE_RELEASE_CONFIG), so a helper started as its own process sees them.
import { configure } from "../../../steps/release/config.mjs";

export const TEST_RELEASE_SETTINGS = {
  productRepo: "MichaelZelbel/godspeed-mission-control",
  kitBootstrapRepo: "MichaelZelbel/kit-bootstrap",
  server: "godspeed-archon",
  godspeedOnServer: "/root/godspeed",
  stagingOnServer: "/root/godspeed-staging",
  timezone: "Europe/Berlin",
  ownerName: "Michael",
  gitEmail: "godspeed@zelbel.de",
  deliveryAuthors: ["godspeed-dev-builder", "godspeed-dev-release"],
  ownerLogin: "MichaelZelbel",
  trustedBots: ["godspeed-dev-builder[bot]", "godspeed-dev-release[bot]"],
  releaseApp: "godspeed-dev-release[bot]",
  standingDecision: 'Michael, 2026-11-17: "Yes, build those three And roll them out."; bug-fix-only releases start without his yes',
  notifyCommand: "/usr/local/bin/mc-notify --lane bot --profile godspeed --source release-staging",
};

configure(TEST_RELEASE_SETTINGS);
process.env.FORGE_RELEASE_CONFIG = JSON.stringify(TEST_RELEASE_SETTINGS);
