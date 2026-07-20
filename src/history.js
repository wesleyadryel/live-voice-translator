let meetings = [];
import { localizePage, t } from "./i18n.js";
let locale = "en";

function escapeHtml(value = "") {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function markdownToHtml(markdown = "") {
  return markdown.split("\n").map((line) => {
    if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
    if (line.startsWith("# ")) return `<h2>${escapeHtml(line.slice(2))}</h2>`;
    if (/^[-*] /.test(line)) return `<p>• ${escapeHtml(line.slice(2))}</p>`;
    if (/^\d+\. /.test(line)) return `<p>${escapeHtml(line)}</p>`;
    if (line.startsWith("> ")) return `<p>${escapeHtml(line.slice(2))}</p>`;
    return line ? `<p>${escapeHtml(line)}</p>` : "";
  }).join("");
}

function meetingMarkdown(meeting) {
  const transcript = meeting.transcript?.length
    ? `\n\n## Полный текст\n\n${meeting.transcript.map((item) => `- [${Math.floor(item.offsetSeconds / 60)}:${String(item.offsetSeconds % 60).padStart(2, "0")}] **${item.speaker}:** ${item.text}`).join("\n")}`
    : "";
  return `# ${meeting.title}\n\n${meeting.summary || "Конспект не создавался."}${transcript}`;
}

function download(meeting) {
  const blob = new Blob([meetingMarkdown(meeting)], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `meeting-${new Date(meeting.startedAt).toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function showMeeting(id) {
  const meeting = meetings.find((item) => item.id === id);
  if (!meeting) return;
  document.querySelectorAll(".meeting-item").forEach((item) => item.classList.toggle("active", item.dataset.id === id));
  const duration = `${Math.floor(meeting.durationSeconds / 60)} мин`;
  document.querySelector("#meeting-view").innerHTML = `
    <header class="meeting-head"><h1>${escapeHtml(meeting.title)}</h1><p>${new Date(meeting.startedAt).toLocaleString(locale)} · ${duration}</p><div class="meeting-actions"><button id="copy-meeting">${t(locale, "copy")}</button><button id="download-meeting">${t(locale, "download")}</button><button class="delete-meeting" id="delete-meeting">${t(locale, "delete")}</button></div></header>
    <section class="summary">${markdownToHtml(meeting.summary || "Конспект не создавался.")}</section>
    ${meeting.transcript?.length ? `<section class="transcript"><h2>${t(locale, "fullTranscript")}</h2>${meeting.transcript.map((item) => `<div class="transcript-row"><time>${Math.floor(item.offsetSeconds / 60)}:${String(item.offsetSeconds % 60).padStart(2, "0")}</time><strong>${escapeHtml(item.speaker)}</strong><span>${escapeHtml(item.text)}</span></div>`).join("")}</section>` : ""}`;
  document.querySelector("#copy-meeting").onclick = () => navigator.clipboard.writeText(meetingMarkdown(meeting));
  document.querySelector("#download-meeting").onclick = () => download(meeting);
  document.querySelector("#delete-meeting").onclick = () => deleteMeeting(meeting.id);
}

async function deleteMeeting(id) {
  const meeting = meetings.find((item) => item.id === id);
  if (!meeting || !confirm(t(locale, "deleteMeetingConfirm", { title: meeting.title }))) return;
  meetings = meetings.filter((item) => item.id !== id);
  await chrome.storage.local.set({ meetings, lastMeetingId: meetings[0]?.id || null });
  await render();
  if (!meetings.length) document.querySelector("#meeting-view").innerHTML = `<div class="empty-state"><h1>${t(locale, "meetingDeleted")}</h1><p>${t(locale, "noMeetingsCopy")}</p></div>`;
}

async function render() {
  const settings = await chrome.storage.local.get({ meetings: [], interfaceLanguage: "en" });
  meetings = settings.meetings;
  locale = settings.interfaceLanguage || "en";
  document.title = t(locale, "historyTitle");
  localizePage(locale);
  const list = document.querySelector("#history-list");
  list.innerHTML = meetings.map((meeting) => `<button class="meeting-item" data-id="${meeting.id}"><strong>${escapeHtml(meeting.title)}</strong><small>${new Date(meeting.startedAt).toLocaleDateString(locale)} · ${Math.floor(meeting.durationSeconds / 60)} min</small></button>`).join("");
  list.querySelectorAll(".meeting-item").forEach((item) => item.onclick = () => showMeeting(item.dataset.id));
  const requestedId = location.hash.slice(1);
  if (meetings[0]) showMeeting(meetings.some((item) => item.id === requestedId) ? requestedId : meetings[0].id);
}

document.querySelector("#clear-history").addEventListener("click", async () => {
  if (!confirm(t(locale, "clearConfirm"))) return;
  await chrome.storage.local.remove(["meetings", "lastMeetingId"]);
  meetings = [];
  document.querySelector("#history-list").innerHTML = "";
  document.querySelector("#meeting-view").innerHTML = `<div class="empty-state"><h1>${t(locale, "historyCleared")}</h1><p>${t(locale, "noMeetingsCopy")}</p></div>`;
});

render();
