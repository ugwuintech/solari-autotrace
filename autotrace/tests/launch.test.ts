import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SolariError, type BrowserSession, type Solari } from "@solarisdk/browser";
import { isTransientSessionFailure, launchBrowser } from "../src/browser/launch.js";
import type { RecoveryEvent } from "../src/types/recovery.js";

// The failure observed in a real run when Solari session creation was briefly unavailable.
const exhausted = () => new SolariError("Solari POST /sessions: exhausted 2 attempts");

// A Solari stand-in whose launch() fails or succeeds in a scripted order; only launch is used.
function scriptedSolari(outcomes: Array<Error | "ok">): { solari: Solari; launches: () => number } {
  let calls = 0;
  const fake = {
    async launch(): Promise<BrowserSession> {
      const outcome = outcomes[calls];
      calls += 1;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return {} as BrowserSession;
    },
  };
  return { solari: fake as unknown as Solari, launches: () => calls };
}

describe("isTransientSessionFailure", () => {
  it("recognises an exhausted session request and nothing else", () => {
    assert.equal(isTransientSessionFailure(exhausted()), true);
    assert.equal(isTransientSessionFailure(new SolariError("Solari POST /sessions: 401", 401)), false);
    assert.equal(isTransientSessionFailure(new Error("exhausted 2 attempts")), false);
  });
});

describe("launchBrowser", () => {
  it("launches without recording anything when the first attempt works", async () => {
    const { solari, launches } = scriptedSolari(["ok"]);
    const recoveries: RecoveryEvent[] = [];

    await launchBrowser(solari, {}, "web search", (event) => recoveries.push(event), 0);

    assert.equal(launches(), 1);
    assert.deepEqual(recoveries, []);
  });

  it("retries once after a transient session failure and records the recovery", async () => {
    const { solari, launches } = scriptedSolari([exhausted(), "ok"]);
    const recoveries: RecoveryEvent[] = [];

    await launchBrowser(solari, {}, "source extraction", (event) => recoveries.push(event), 0);

    assert.equal(launches(), 2);
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0]?.step, "source extraction");
    assert.match(recoveries[0]?.failure ?? "", /exhausted 2 attempts/);
  });

  it("does not retry an error that is not transient", async () => {
    const { solari, launches } = scriptedSolari([new SolariError("Solari POST /sessions: 401", 401)]);

    await assert.rejects(launchBrowser(solari, {}, "web search", undefined, 0), /401/);
    assert.equal(launches(), 1);
  });

  it("gives up after one retry", async () => {
    const { solari, launches } = scriptedSolari([exhausted(), exhausted()]);
    const recoveries: RecoveryEvent[] = [];

    await assert.rejects(launchBrowser(solari, {}, "web search", (event) => recoveries.push(event), 0), /exhausted/);
    assert.equal(launches(), 2);
    assert.deepEqual(recoveries, []);
  });
});
