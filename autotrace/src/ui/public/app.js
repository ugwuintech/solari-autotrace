/**
 * AutoTrace UI client.
 * Submits investigation input to the local API and renders the shared pipeline result.
 * Every rendered claim comes from the API payload; the client only reshapes it for display.
 */

const form = document.getElementById("investigation-form");
const submitButton = document.getElementById("submit-button");
const codesInput = document.getElementById("codes");
const codePreview = document.getElementById("code-preview");
const idlePanel = document.getElementById("idle-panel");
const statusPanel = document.getElementById("status-panel");
const statusVehicle = document.getElementById("status-vehicle");
const elapsedText = document.getElementById("elapsed");
const errorPanel = document.getElementById("error-panel");
const errorTitle = document.getElementById("error-title");
const errorDetail = document.getElementById("error-detail");
const resultPanel = document.getElementById("result-panel");

const SUPPORT_LEVELS = {
  "strongly-supported": 4,
  "moderately-supported": 3,
  "weakly-supported": 2,
  "insufficient-evidence": 0,
  contradicted: 0,
};

const POLARITIES = ["supports", "contradicts", "context"];

let inFlight = false;
let elapsedTimer = null;
let evidenceItems = [];
let evidenceFilter = "all";

// Escape text before inserting into HTML.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Build a clickable source link when a URL is present.
function sourceLink(title, url) {
  const safeTitle = escapeHtml(title);
  if (!url) {
    return safeTitle;
  }
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>`;
}

// Show the host of a source URL so the reader can judge where a claim came from.
function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Split the codes field the same loose way a technician types it: commas, spaces or semicolons.
function splitCodes(raw) {
  return raw
    .split(/[\s,;]+/)
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
}

function codeChips(codes) {
  return codes.map((code) => `<span class="code">${escapeHtml(code)}</span>`).join("");
}

function polarityTag(polarity) {
  return `<span class="tag ${escapeHtml(polarity)}">${escapeHtml(polarity)}</span>`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/* ---------- Car and scope drawing ---------- */

let carCount = 0;

// Side-profile sedan. Each copy gets its own gradient id so several cars can share the page.
function carSvg() {
  carCount += 1;
  const beamId = `beam-${carCount}`;
  const wheel = (x) => `
    <g transform="translate(${x} 58)">
      <g class="spin">
        <circle class="tyre" r="13" />
        <circle class="rim" r="7" />
        <line class="spoke" x1="-7" y1="0" x2="7" y2="0" />
        <line class="spoke" x1="0" y1="-7" x2="0" y2="7" />
      </g>
    </g>`;

  return `
    <svg viewBox="0 0 240 76">
      <defs>
        <linearGradient id="${beamId}" x1="0" x2="1">
          <stop offset="0" stop-color="#f3e6c4" stop-opacity="0.3" />
          <stop offset="1" stop-color="#f3e6c4" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path class="beam" fill="url(#${beamId})" d="M224 46 L330 34 L330 66 Z" />
      <circle class="puff" cx="10" cy="55" r="3" />
      <circle class="puff" cx="10" cy="55" r="3" />
      <circle class="puff" cx="10" cy="55" r="3" />
      <g class="chassis">
        <path class="body" d="M14 58 L12 46 L20 40 L58 37 L80 22 L136 20 L166 36 L214 42 L226 49 L226 58 L196 58 A16 16 0 0 0 164 58 L76 58 A16 16 0 0 0 44 58 Z" />
        <path class="glass" d="M64 37 L83 25 L112 24 L112 37 Z M118 24 L135 24 L156 36 L118 37 Z" />
        <path class="beltline" d="M22 44 L212 46" />
        <rect class="lamp front" x="216" y="44" width="8" height="4" rx="1" />
        <rect class="lamp rear" x="13" y="44" width="6" height="5" rx="1" />
      </g>
      ${wheel(60)}
      ${wheel(180)}
    </svg>`;
}

// Secondary ignition pattern: firing spike, spark line, coil ringing. Repeats every 150 units.
function scopePath() {
  const parts = [];
  for (let start = 0; start <= 750; start += 150) {
    const p = (x) => start + x;
    parts.push(
      `${start === 0 ? "M" : "L"}${p(0)} 40 L${p(18)} 40 L${p(20)} 6 L${p(22)} 30 L${p(60)} 27`,
      `L${p(62)} 47 L${p(66)} 34 L${p(70)} 44 L${p(74)} 37 L${p(78)} 42 L${p(82)} 39 L${p(86)} 40 L${p(150)} 40`
    );
  }
  return parts.join(" ");
}

function drawScenery() {
  for (const slot of document.querySelectorAll("[data-car]")) {
    slot.innerHTML = carSvg();
  }
  document.getElementById("scope-path").setAttribute("d", scopePath());
}

/* ---------- Stage switching ---------- */

function showStage(stage) {
  idlePanel.hidden = stage !== "idle";
  statusPanel.hidden = stage !== "running";
  errorPanel.hidden = stage !== "error";
  resultPanel.hidden = stage !== "result";
}

function startElapsed() {
  const started = Date.now();
  elapsedText.textContent = "00:00";
  elapsedTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    elapsedText.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopElapsed() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

// Show a human-readable API or validation error without a stack trace.
function showError(title, detail) {
  errorTitle.textContent = title;
  errorDetail.textContent = detail;
  showStage("error");
}

// Toggle loading state and prevent duplicate submissions.
function setLoading(isLoading, vehicle = "") {
  inFlight = isLoading;
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Investigating…" : "Run investigation";
  if (isLoading) {
    statusVehicle.textContent = vehicle;
    showStage("running");
    startElapsed();
  } else {
    stopElapsed();
  }
}

/* ---------- Result rendering ---------- */

function renderCaseHeader(input, summary) {
  document.getElementById("case-vehicle").textContent = input.vehicle;
  document.getElementById("case-codes").innerHTML = codeChips(splitCodes(input.codes));

  const stats = [
    ["Rounds", summary.researchRounds, ""],
    ["Evidence", summary.evidenceCount, ""],
    ["Open questions", summary.unresolvedQuestionCount, ""],
    ["Model", summary.reasoningProvider, "small"],
  ];
  document.getElementById("summary").innerHTML = stats
    .map(
      ([label, value, size]) =>
        `<div><dt>${label}</dt><dd class="${size}">${escapeHtml(value)}</dd></div>`
    )
    .join("");
}

// Qualitative gauge: segments only echo the support label, they are not a measured probability.
function supportGauge(item) {
  const support = item.support ?? "unassessed";
  const filled = SUPPORT_LEVELS[support] ?? 0;
  const segments = [0, 1, 2, 3]
    .map((index) => `<span class="${index < filled ? "on" : ""}"></span>`)
    .join("");
  return `
    <div class="gauge ${escapeHtml(support)}">
      <div class="gauge-bar" aria-hidden="true">${segments}</div>
      <span class="gauge-label">${escapeHtml(item.supportLabel)}</span>
    </div>`;
}

function mentionTally(mentions) {
  if (mentions.length === 0) {
    return `<p class="tally">No collected source mentions this system.</p>`;
  }
  const counts = POLARITIES.map((polarity) => {
    const count = mentions.filter((mention) => mention.polarity === polarity).length;
    return `<span class="${polarity}"><b>${count}</b> ${polarity}</span>`;
  });
  return `<p class="tally">${counts.join("")}</p>`;
}

function linkList(heading, links) {
  if (links.length === 0) {
    return "";
  }
  const items = links.map((link) => `<li>${sourceLink(link.title, link.url)}</li>`).join("");
  return `<div class="detail-group"><h5>${heading}</h5><ul>${items}</ul></div>`;
}

function mentionList(mentions) {
  if (mentions.length === 0) {
    return "";
  }
  const items = mentions
    .map(
      (mention) => `
        <li>
          ${polarityTag(mention.polarity)} ${sourceLink(mention.title, mention.url)}
          <span class="reason">${escapeHtml(mention.polarityReason)}</span>
        </li>`
    )
    .join("");
  return `<div class="detail-group"><h5>Source polarity (rule-based)</h5><ul>${items}</ul></div>`;
}

function renderHypotheses(hypotheses) {
  const container = document.getElementById("hypotheses");
  if (!hypotheses || hypotheses.length === 0) {
    container.innerHTML = `<p class="empty">No hypotheses available.</p>`;
    return;
  }

  container.innerHTML = hypotheses
    .map((item) => {
      const details =
        linkList("Cited as supporting", item.supportingEvidence) +
        linkList("Cited as contradicting", item.contradictingEvidence) +
        mentionList(item.mentions);

      return `
        <article class="hyp">
          <div class="hyp-head">
            <span class="hyp-id">${escapeHtml(item.id)}</span>
            <h3 class="hyp-label">${escapeHtml(item.label)}</h3>
          </div>
          ${supportGauge(item)}
          <p class="hyp-explanation">${escapeHtml(item.explanation)}</p>
          ${mentionTally(item.mentions)}
          ${details ? `<details><summary>Sources</summary>${details}</details>` : ""}
        </article>`;
    })
    .join("");
}

function renderEvidenceFilter() {
  const options = ["all", ...POLARITIES];
  document.getElementById("evidence-filter").innerHTML = options
    .map((option) => {
      const count =
        option === "all"
          ? evidenceItems.length
          : evidenceItems.filter((item) => item.relevance === option).length;
      const label = option === "all" ? "All" : option[0].toUpperCase() + option.slice(1);
      return `<button type="button" data-filter="${option}" aria-pressed="${option === evidenceFilter}">${label} ${count}</button>`;
    })
    .join("");
}

function renderEvidenceList() {
  const container = document.getElementById("evidence");
  if (evidenceItems.length === 0) {
    container.innerHTML = `<li class="empty">No usable evidence was collected.</li>`;
    return;
  }

  // Keep original numbering so a filtered item still matches its position in the full list.
  const rows = evidenceItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => evidenceFilter === "all" || item.relevance === evidenceFilter);

  if (rows.length === 0) {
    container.innerHTML = `<li class="empty">No evidence in this category.</li>`;
    return;
  }

  container.innerHTML = rows
    .map(
      ({ item, index }) => `
        <li class="evidence-item">
          <span class="evidence-index">${String(index + 1).padStart(2, "0")}</span>
          <div class="evidence-title">${sourceLink(item.title, item.url)} ${polarityTag(item.relevance)}</div>
          <span class="evidence-domain">${escapeHtml(sourceDomain(item.url))}</span>
          <p class="evidence-finding">${escapeHtml(item.finding)}</p>
        </li>`
    )
    .join("");
}

function renderEvidence(evidence) {
  evidenceItems = evidence ?? [];
  evidenceFilter = "all";
  renderEvidenceFilter();
  renderEvidenceList();
}

function renderAssessment(reasoning, unknowns) {
  document.getElementById("reasoning").innerHTML = reasoning
    ? `<div class="reasoning"><span class="reasoning-label">Model reasoning</span>${escapeHtml(reasoning)}</div>`
    : `<p class="empty">No assessment was produced.</p>`;

  const container = document.getElementById("unknowns");
  if (!unknowns || unknowns.length === 0) {
    container.innerHTML = `<p class="empty">None recorded.</p>`;
    return;
  }
  container.innerHTML = `<ul class="unknown-list">${unknowns
    .map(
      (item) => `
        <li>
          <strong>${escapeHtml(item.question)}</strong>
          <p>${escapeHtml(item.whyItMatters)}</p>
        </li>`
    )
    .join("")}</ul>`;
}

function renderNextTest(test) {
  const container = document.getElementById("next-test");
  if (!test) {
    container.innerHTML = `<p class="empty">No test was recommended.</p>`;
    return;
  }

  const steps = test.procedure.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  const separates =
    test.distinguishes.length === 0
      ? ""
      : `<div class="separates">Helps separate ${test.distinguishes
          .map((item) => `<span>${escapeHtml(item)}</span>`)
          .join("")}</div>`;

  container.innerHTML = `
    <article class="test">
      <h3 class="test-name">${escapeHtml(test.name)}</h3>
      <p class="test-purpose">${escapeHtml(test.purpose)}</p>
      <ol class="steps">${steps}</ol>
      ${separates}
    </article>`;
}

// Render a full InvestigationUiResult payload, with sections rising in sequence.
function renderResult(input, result) {
  renderCaseHeader(input, result.summary);
  document.getElementById("disclaimer").textContent = result.disclaimer;

  const reassessment = document.getElementById("reassessment-error");
  reassessment.hidden = !result.reassessmentError;
  reassessment.textContent = result.reassessmentError
    ? `Follow-up reassessment failed, so the first-round assessment is shown. ${result.reassessmentError}`
    : "";

  renderHypotheses(result.hypotheses);
  renderEvidence(result.evidence);
  renderAssessment(result.reasoning, result.unknowns);
  renderNextTest(result.recommendedNextTest);

  resultPanel.querySelectorAll(".reveal").forEach((element, index) => {
    element.style.setProperty("--i", String(index));
    // Restart the animation when a second investigation replaces the first.
    element.style.animation = "none";
    void element.offsetWidth;
    element.style.animation = "";
  });
  showStage("result");
  resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- Events ---------- */

function validateForm(vehicle, codes) {
  if (!vehicle) {
    return "Vehicle is required.";
  }
  if (!codes) {
    return "At least one diagnostic code is required.";
  }
  return null;
}

codesInput.addEventListener("input", () => {
  codePreview.innerHTML = codeChips(splitCodes(codesInput.value));
});

document.getElementById("evidence-filter").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) {
    return;
  }
  evidenceFilter = button.dataset.filter;
  renderEvidenceFilter();
  renderEvidenceList();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (inFlight) {
    return;
  }

  const input = {
    vehicle: document.getElementById("vehicle").value.trim(),
    codes: codesInput.value.trim(),
    symptoms: document.getElementById("symptoms").value,
  };

  const validationError = validateForm(input.vehicle, input.codes);
  if (validationError) {
    showError("Check the investigation input", validationError);
    return;
  }

  setLoading(true, input.vehicle);

  try {
    const response = await fetch("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    const payload = await response.json();

    if (!response.ok) {
      showError(
        payload.error ?? "Investigation failed",
        payload.detail ?? "Unable to complete the investigation. Check the terminal for details and try again."
      );
      return;
    }

    renderResult(input, payload);
  } catch (error) {
    showError(
      "Investigation failed",
      "Unable to complete the investigation. Check that the AutoTrace server is running and try again."
    );
    console.error(error);
  } finally {
    setLoading(false);
  }
});

drawScenery();
showStage("idle");
