import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRankTerms, deduplicateByUrl, evaluateCandidates, forumThreadKey, isUnreadableSource } from "../src/research/rank.js";

// The two URL shapes for one mbworld.org thread seen in the baseline research run.
const threadInCClass = "https://mbworld.org/forums/c-class-w203/865023-05-c240-cylinder-5-misfire.html";
const threadInW203 =
  "https://mbworld.org/forums/w203-s203-c-2001-2007-c-160-c-230-k-240-270-cdi-280-320-cdi-350/865023-05-c240-cylinder-5-misfire.html";

describe("forumThreadKey", () => {
  it("gives a thread filed under two category paths the same key", () => {
    assert.equal(forumThreadKey(threadInCClass), "mbworld.org#thread-865023");
    assert.equal(forumThreadKey(threadInW203), "mbworld.org#thread-865023");
  });

  it("recognises XenForo and classic vBulletin thread URLs", () => {
    assert.equal(forumThreadKey("https://www.example-forum.test/threads/p0305-misfire.12345/"), "example-forum.test#thread-12345");
    assert.equal(forumThreadKey("https://forum.test/showthread.php?t=987&page=2"), "forum.test#thread-987");
  });

  it("returns null for URLs that are not forum threads", () => {
    assert.equal(forumThreadKey("https://www.obd-codes.test/p0305"), null);
    assert.equal(forumThreadKey("not a url"), null);
  });

  it("keeps different threads on the same forum apart", () => {
    assert.notEqual(
      forumThreadKey(threadInCClass),
      forumThreadKey("https://mbworld.org/forums/c-class-w203/534740-p2187-p2189-p0300.html")
    );
  });
});

describe("deduplicateByUrl", () => {
  it("keeps only the first copy of a thread that appears under two paths", () => {
    const unique = deduplicateByUrl([
      { title: "05 C240 cylinder 5 misfire", url: threadInCClass },
      { title: "05 C240 cylinder 5 misfire", url: threadInW203 },
      { title: "P0305 reference", url: "https://www.obd-codes.test/p0305" },
    ]);

    assert.deepEqual(
      unique.map((item) => item.url),
      [threadInCClass, "https://www.obd-codes.test/p0305"]
    );
  });
});

describe("unreadable sources", () => {
  const terms = buildRankTerms({
    vehicle: { make: "Mercedes-Benz", model: "C240", platform: "W203" },
    codes: [{ code: "P2001" }],
  });

  it("recognises video, paywalled and login-walled hosts", () => {
    assert.equal(isUnreadableSource("https://www.justanswer.com/mercedes/abc-c240-p2001.html"), true);
    assert.equal(isUnreadableSource("https://www.youtube.com/playlist?list=abc"), true);
    assert.equal(isUnreadableSource("https://mbworld.org/forums/c-class-w203/1-p2001.html"), false);
  });

  it("excludes a paywalled page even when its title matches the vehicle and code", () => {
    const [evaluation] = evaluateCandidates(
      [{ title: "2004 Mercedes C240 engine code P2001", url: "https://www.justanswer.com/mercedes/ccd2b-2004-mercedes-c240-engine-code-p2001.html" }],
      terms
    );

    assert.equal(evaluation?.score, 0);
    assert.match(evaluation?.exclusionReason ?? "", /no readable text/);
  });
});
