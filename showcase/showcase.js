const params = new URLSearchParams(location.search);
const view = ["live", "history", "settings"].includes(params.get("view")) ? params.get("view") : "live";
document.body.dataset.view = view;

const content = {
  live: {
    title: "A meeting, translated live.",
    copy: "Two-way speech translation and a speaker-labelled transcript inside your browser.",
    source: "../src/popup.html"
  },
  history: {
    title: "Every decision, ready after the call.",
    copy: "Local meeting history turns transcripts into clear decisions, owners, deadlines, and next steps.",
    source: "../src/history.html"
  },
  settings: {
    title: "Your languages. Your voices. Your data.",
    copy: "Configure both directions, audio routing, retention, and meeting-note structure in one place.",
    source: "../src/options.html"
  }
}[view];

document.querySelector("#showcase-title").textContent = content.title;
document.querySelector("#showcase-copy").textContent = content.copy;
const frame = document.querySelector("#product-frame");
frame.src = content.source;

frame.addEventListener("load", () => {
  const doc = frame.contentDocument;
  doc.documentElement.lang = "en";
  if (view === "live") seedLive(doc);
  if (view === "history") seedHistory(doc);
  if (view === "settings") seedSettings(doc);
});

function seedLive(doc) {
  const showcaseStyle = doc.createElement("style");
  showcaseStyle.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}#error,#recording-notice,#setup-banner{display:none!important}";
  doc.head.append(showcaseStyle);
  doc.body.style.zoom = ".76";
  doc.body.classList.add("is-live");
  doc.querySelector("#status-label").textContent = "Live";
  doc.querySelector("#capture-context").textContent = "Google Meet";
  doc.querySelector("#session-timer").textContent = "18:42";
  doc.querySelector("#source-label").textContent = "English";
  doc.querySelector("#target-label").textContent = "Spanish";
  doc.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === "both"));
  doc.querySelector("#mode-help").textContent = "Both participants hear the translation while a structured meeting record is created.";
  doc.querySelector("#source-language").value = "English";
  doc.querySelector("#target-language").value = "Spanish";
  doc.querySelector("#toggle-label").textContent = "Stop meeting";
  doc.querySelector("#usage-label").textContent = "Used 146 min · 8 sessions";
  doc.querySelector("#key-status").textContent = "OpenAI connected";
  doc.querySelector("#transcript-count").textContent = "6";
  doc.querySelector("#transcript-policy").textContent = "Saved with notes";
  const transcriptMarkup = `
    <article class="transcript-line"><header><strong>You</strong><time>18:40</time></header><p>Let's confirm the rollout plan for the new support workflow.</p></article>
    <article class="transcript-line is-participant"><header><strong>Maria</strong><time>18:41</time></header><p>Perfecto. El equipo piloto puede empezar el miércoles.</p></article>
    <article class="transcript-line"><header><strong>You</strong><time>18:42</time></header><p>Great — I will share the checklist and success metrics today.</p></article>`;
  const renderTranscript = () => { doc.querySelector("#transcript-feed").innerHTML = transcriptMarkup; };
  renderTranscript();
  setTimeout(renderTranscript, 400);
  doc.querySelectorAll(".preflight > div").forEach(item => { item.dataset.state = "ok"; item.querySelector("small").textContent = "Ready"; });
}

function seedHistory(doc) {
  const meetings = [
    ["Product rollout — weekly sync", "Today · 42 min"],
    ["Enterprise onboarding", "Monday · 58 min"],
    ["AI quality review", "18 Jul · 36 min"],
    ["Customer discovery", "16 Jul · 51 min"]
  ];
  doc.querySelector("#history-count").textContent = "4 meetings · stored locally";
  doc.querySelector("#history-list").innerHTML = meetings.map((item, index) => `<button class="meeting-item ${index === 0 ? "active" : ""}"><strong>${item[0]}</strong><small>${item[1]}</small></button>`).join("");
  doc.querySelector("#meeting-view").innerHTML = `
    <header class="meeting-head"><h1>Product rollout — weekly sync</h1><p>Today, 10:00 · 42 minutes · English ↔ Spanish</p><div class="meeting-actions"><button>Copy notes</button><button>Download Markdown</button><button class="delete-meeting">Delete</button></div></header>
    <section class="summary"><h2>Overview</h2><p>The team approved a phased rollout for the new AI-assisted support workflow, starting with two enterprise customers.</p><h2>Decisions</h2><p class="summary-list-item">• Pilot starts on Wednesday with English and Spanish support.</p><p class="summary-list-item">• Success will be measured by resolution time, handoff rate, and customer satisfaction.</p><h2>Action items</h2><p class="summary-list-item">• Dmitry — share rollout checklist and dashboard by end of day.</p><p class="summary-list-item">• Maria — confirm pilot users before Tuesday, 16:00.</p><h2>Open questions</h2><p class="summary-list-item">• Should the second phase include German-language calls?</p></section>
    <section class="transcript"><h2>Transcript</h2><div class="transcript-row"><time>10:02</time><strong>Dmitry</strong><span>Let's confirm the rollout plan and the success metrics.</span></div><div class="transcript-row"><time>10:03</time><strong>Maria</strong><span>The pilot team can start on Wednesday.</span></div></section>`;
}

function seedSettings(doc) {
  doc.querySelector("#api-key").value = "demo-key-not-a-real-secret";
  doc.querySelector("#api-test-status").textContent = "Connection verified";
  doc.querySelector("#api-test-status").dataset.state = "success";
  doc.querySelector("#source-language").value = "English";
  doc.querySelector("#target-language").value = "Spanish";
  doc.querySelector("#outgoing-voice").value = "marin";
  doc.querySelector("#incoming-voice").value = "cedar";
  doc.querySelector("#summary-detail").value = "detailed";
  doc.querySelector("#max-session-minutes").value = "90";
  ["overview", "topics", "decisions", "tasks", "deadlines", "owners", "questions"].forEach(id => { doc.querySelector(`#summary-${id}`).checked = true; });
  doc.querySelector("#speaker-diarization").checked = true;
}
