/**
 * AutoTrace tester UI client.
 * Submits investigation input to the local API and renders the shared pipeline result.
 */

const form = document.getElementById("investigation-form");
const submitButton = document.getElementById("submit-button");
const statusPanel = document.getElementById("status-panel");
const statusText = document.getElementById("status-text");
const errorPanel = document.getElementById("error-panel");
const errorTitle = document.getElementById("error-title");
const errorDetail = document.getElementById("error-detail");
const resultPanel = document.getElementById("result-panel");

let inFlight = false;

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

// CSS class for qualitative support / polarity badges.
function statusClass(value) {
  if (!value) {
    return "no-assessment";
  }
  return String(value);
}

// Reset result and error panels before a new run.
function clearOutput() {
  errorPanel.hidden = true;
  resultPanel.hidden = true;
  errorTitle.textContent = "";
  errorDetail.textContent = "";
  document.getElementById("summary").innerHTML = "";
  document.getElementById("hypotheses").innerHTML = "";
  document.getElementById("evidence").innerHTML = "";
  document.getElementById("unknowns").innerHTML = "";
  document.getElementById("next-test").innerHTML = "";
  document.getElementById("reasoning").innerHTML = "";
  document.getElementById("disclaimer").textContent = "";
}

// Show a human-readable API or validation error without a stack trace.
function showError(title, detail) {
  errorPanel.hidden = false;
  errorTitle.textContent = title;
  errorDetail.textContent = detail;
}

// Render the investigation summary strip.
function renderSummary(summary) {
  document.getElementById("summary").innerHTML = `
    <div><strong>${escapeHtml(summary.researchRounds)}</strong> research round${summary.researchRounds === 1 ? "" : "s"}</div>
    <div><strong>${escapeHtml(summary.evidenceCount)}</strong> evidence item${summary.evidenceCount === 1 ? "" : "s"}</div>
    <div><strong>${escapeHtml(summary.unresolvedQuestionCount)}</strong> unresolved question${summary.unresolvedQuestionCount === 1 ? "" : "s"}</div>
    <div>Reasoning: <strong>${escapeHtml(summary.reasoningProvider)}</strong></div>
  `;
}

// Render competing hypotheses with assessment status and polarity mentions.
function renderHypotheses(hypotheses) {
  const container = document.getElementById("hypotheses");
  if (!hypotheses || hypotheses.length === 0) {
    container.innerHTML = `<div class="block"><h3>Hypotheses</h3><p class="empty">None available.</p></div>`;
    return;
  }

  const cards = hypotheses
    .map((item) => {
      const supportList =
        item.supportingEvidence.length === 0
          ? "<li>none</li>"
          : item.supportingEvidence
              .map((ref) => `<li>${sourceLink(ref.title, ref.url)}</li>`)
              .join("");
      const contradictList =
        item.contradictingEvidence.length === 0
          ? "<li>none</li>"
          : item.contradictingEvidence
              .map((ref) => `<li>${sourceLink(ref.title, ref.url)}</li>`)
              .join("");
      const mentions =
        item.mentions.length === 0
          ? `<p class="empty">No evidence mentions collected for this system yet.</p>`
          : `<ul class="list">${item.mentions
              .map(
                (mention) => `
              <li>
                ${sourceLink(mention.title, mention.url)}
                <div class="meta">
                  Polarity:
                  <span class="status-pill ${statusClass(mention.polarity)}">${escapeHtml(mention.polarity)}</span>
                  — ${escapeHtml(mention.polarityReason)}
                </div>
              </li>`
              )
              .join("")}</ul>`;

      return `
        <article class="card">
          <h4>${escapeHtml(item.id)} — ${escapeHtml(item.label)}</h4>
          <p class="meta">
            Status:
            <span class="status-pill ${statusClass(item.support)}">${escapeHtml(item.supportLabel)}</span>
          </p>
          <p class="finding"><strong>Explanation:</strong> ${escapeHtml(item.explanation)}</p>
          <p class="meta"><strong>Supporting evidence</strong></p>
          <ul class="list">${supportList}</ul>
          <p class="meta"><strong>Contradicting evidence</strong></p>
          <ul class="list">${contradictList}</ul>
          <p class="meta"><strong>Evidence polarity (deterministic)</strong></p>
          ${mentions}
        </article>
      `;
    })
    .join("");

  container.innerHTML = `<div class="block"><h3>Hypotheses</h3>${cards}</div>`;
}

// Render collected evidence with relevance and clickable URLs.
function renderEvidence(evidence) {
  const container = document.getElementById("evidence");
  if (!evidence || evidence.length === 0) {
    container.innerHTML = `<div class="block"><h3>Evidence</h3><p class="empty">No usable evidence was collected.</p></div>`;
    return;
  }

  const cards = evidence
    .map(
      (item) => `
      <article class="card">
        <h4>${sourceLink(item.title, item.url)}</h4>
        <p class="meta">
          Relevance:
          <span class="status-pill ${statusClass(item.relevance)}">${escapeHtml(item.relevance)}</span>
        </p>
        <p class="finding">${escapeHtml(item.finding)}</p>
        <p class="meta">${sourceLink(item.url, item.url)}</p>
      </article>`
    )
    .join("");

  container.innerHTML = `<div class="block"><h3>Evidence</h3>${cards}</div>`;
}

// Render unresolved questions from the assessment.
function renderUnknowns(unknowns) {
  const container = document.getElementById("unknowns");
  if (!unknowns || unknowns.length === 0) {
    container.innerHTML = `<div class="block"><h3>Unknowns</h3><p class="empty">None recorded.</p></div>`;
    return;
  }

  const items = unknowns
    .map(
      (item) => `
      <article class="card">
        <h4>${escapeHtml(item.question)}</h4>
        <p class="finding">${escapeHtml(item.whyItMatters)}</p>
      </article>`
    )
    .join("");

  container.innerHTML = `<div class="block"><h3>Unknowns</h3>${items}</div>`;
}

// Render the recommended next diagnostic test.
function renderNextTest(test) {
  const container = document.getElementById("next-test");
  if (!test) {
    container.innerHTML = `<div class="block"><h3>Recommended next test</h3><p class="empty">No test was recommended.</p></div>`;
    return;
  }

  const steps = test.procedure
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join("");
  const distinguishes =
    test.distinguishes.length === 0
      ? "<li>none named</li>"
      : test.distinguishes.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  container.innerHTML = `
    <div class="block">
      <h3>Recommended next test</h3>
      <article class="card">
        <h4>${escapeHtml(test.name)}</h4>
        <p class="finding"><strong>Purpose:</strong> ${escapeHtml(test.purpose)}</p>
        <p class="meta"><strong>Procedure</strong></p>
        <ol class="list">${steps}</ol>
        <p class="meta"><strong>Hypotheses this test may distinguish</strong></p>
        <ul class="list">${distinguishes}</ul>
      </article>
    </div>
  `;
}

// Render Qwen's reasoning summary when present.
function renderReasoning(reasoning) {
  const container = document.getElementById("reasoning");
  if (!reasoning) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div class="block">
      <h3>Assessment reasoning</h3>
      <article class="card">
        <p class="finding">${escapeHtml(reasoning)}</p>
      </article>
    </div>
  `;
}

// Render a full InvestigationUiResult payload.
function renderResult(result) {
  resultPanel.hidden = false;
  renderSummary(result.summary);
  renderHypotheses(result.hypotheses);
  renderEvidence(result.evidence);
  renderUnknowns(result.unknowns);
  renderNextTest(result.recommendedNextTest);
  renderReasoning(result.reasoning);
  document.getElementById("disclaimer").textContent = result.disclaimer;
}

// Toggle loading state and prevent duplicate submissions.
function setLoading(isLoading) {
  inFlight = isLoading;
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Researching..." : "Run Investigation";
  statusPanel.hidden = !isLoading;
  if (isLoading) {
    statusText.textContent = "Researching...";
  }
}

// Validate required fields in the browser before calling the API.
function validateForm(vehicle, codes) {
  if (!vehicle) {
    return "Vehicle is required.";
  }
  if (!codes) {
    return "At least one diagnostic code is required.";
  }
  return null;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (inFlight) {
    return;
  }

  const vehicle = document.getElementById("vehicle").value.trim();
  const codes = document.getElementById("codes").value.trim();
  const symptoms = document.getElementById("symptoms").value;

  clearOutput();

  const validationError = validateForm(vehicle, codes);
  if (validationError) {
    showError("Invalid investigation input", validationError);
    return;
  }

  setLoading(true);

  try {
    const response = await fetch("/api/investigate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ vehicle, codes, symptoms }),
    });

    const payload = await response.json();

    if (!response.ok) {
      showError(
        payload.error ?? "Investigation failed",
        payload.detail ?? "Unable to complete the investigation. Check the terminal for details and try again."
      );
      return;
    }

    renderResult(payload);
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
