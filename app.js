/* ==========================================================================
   CONFIGURATION
   1. EXPIRATION_MINUTES: Default clip lifetime in minutes (180 = 3 hours).
   2. API_BASE_URL: Your deployed Cloudflare Worker URL (no trailing slash).
   ========================================================================== */
const EXPIRATION_MINUTES = 1;
const API_BASE_URL = "https://clipvault-api.faisal-n04.workers.dev/";

const LOCAL_LIST_KEY = "clipvault_my_clips_v1";

/* ==========================================================================
   STATE & DOM REFERENCES
   ========================================================================== */
const state = {
  clips: [],
  activeViewerClipId: null,
  tickerId: null
};

const dom = {
  brandLink: document.getElementById("brandLink"),
  retentionLabel: document.getElementById("retentionLabel"),

  uploaderView: document.getElementById("uploaderView"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),

  uploadQueueSection: document.getElementById("uploadQueueSection"),
  uploadQueueList: document.getElementById("uploadQueueList"),
  queueCount: document.getElementById("queueCount"),

  activeCount: document.getElementById("activeCount"),
  copyAllBtn: document.getElementById("copyAllBtn"),
  clearAllBtn: document.getElementById("clearAllBtn"),
  emptyState: document.getElementById("emptyState"),
  clipList: document.getElementById("clipList"),

  viewerView: document.getElementById("viewerView"),
  backToUploaderBtn: document.getElementById("backToUploaderBtn"),
  viewerCard: document.getElementById("viewerCard"),
  viewerTypeBadge: document.getElementById("viewerTypeBadge"),
  viewerFileName: document.getElementById("viewerFileName"),
  viewerMeta: document.getElementById("viewerMeta"),
  viewerTimerBox: document.getElementById("viewerTimerBox"),
  viewerCountdown: document.getElementById("viewerCountdown"),
  viewerMediaStage: document.getElementById("viewerMediaStage"),
  viewerShareUrl: document.getElementById("viewerShareUrl"),
  viewerCopyBtn: document.getElementById("viewerCopyBtn"),

  viewerExpiredCard: document.getElementById("viewerExpiredCard"),
  expiredTitle: document.getElementById("expiredTitle"),
  expiredMessage: document.getElementById("expiredMessage"),
  expiredHomeBtn: document.getElementById("expiredHomeBtn"),

  toastContainer: document.getElementById("toastContainer")
};

/* ==========================================================================
   CLOUDFLARE R2 API SERVICE
   ========================================================================== */
function getApiBase() {
  return API_BASE_URL.replace(/\/+$/, "");
}

function isApiConfigured() {
  return !API_BASE_URL.includes("YOUR-WORKER-NAME");
}

const R2Service = {
  async initUpload({ name, type, mediaKind, size }) {
    const res = await fetch(`${getApiBase()}/api/clips/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        type,
        mediaKind,
        size,
        expirationMinutes: EXPIRATION_MINUTES
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Init failed (${res.status})`);
    return data; // { clip, uploadUrl }
  },

  uploadDirectToR2(uploadUrl, file, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl, true);
      xhr.setRequestHeader("Content-Type", contentType);

      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress((event.loaded / event.total) * 100);
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`R2 upload failed (${xhr.status})`));
        }
      });

      xhr.addEventListener("error", () => {
        reject(new Error("Upload blocked — check R2 bucket CORS policy."));
      });

      xhr.addEventListener("abort", () => {
        reject(new Error("Upload cancelled."));
      });

      xhr.send(file);
    });
  },

  async completeUpload(id, deleteToken) {
    const res = await fetch(`${getApiBase()}/api/clips/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      headers: { "X-Delete-Token": deleteToken }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Finalize failed (${res.status})`);
    return data.clip;
  },

  async fetchClipForViewer(id) {
    const res = await fetch(`${getApiBase()}/api/clips/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not load clip (${res.status})`);
    return data; // { clip, mediaUrl }
  },

  async deleteClip(id, deleteToken) {
    const res = await fetch(`${getApiBase()}/api/clips/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Delete-Token": deleteToken || "" }
    });
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Delete failed (${res.status})`);
    }
  }
};

/* ==========================================================================
   LOCAL DASHBOARD TRACKER (Uploader's Own Active Clips Only)
   Media blobs live in R2; localStorage only remembers your uploaded links &
   delete tokens so other visitors cannot see or delete your clips.
   ========================================================================== */
const LocalHistory = {
  load() {
    try {
      const raw = localStorage.getItem(LOCAL_LIST_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      const active = Array.isArray(parsed) ? parsed.filter((c) => c.expiresAt > now) : [];
      this.save(active);
      return active;
    } catch {
      return [];
    }
  },

  save(clips) {
    try {
      localStorage.setItem(LOCAL_LIST_KEY, JSON.stringify(clips));
    } catch {
      // Ignore storage quota issues for tiny metadata list
    }
  }
};

/* ==========================================================================
   UTILITIES
   ========================================================================== */
function buildShareUrl(clipId) {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#clip=${encodeURIComponent(clipId)}`;
}

function getClipIdFromHash() {
  const match = window.location.hash.match(/^#clip=([a-zA-Z0-9_-]+)$/);
  return match ? match[1] : null;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function formatRetentionHeader(minutes) {
  if (minutes < 60) return `Auto-deletes in ${minutes}m`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `Auto-deletes in ${hrs}h` : `Auto-deletes in ${hrs}h ${mins}m`;
}

function getUrgencyClass(msRemaining) {
  if (msRemaining <= 60 * 1000) return "is-critical";
  if (msRemaining <= 5 * 60 * 1000) return "is-warning";
  return "";
}

function detectMediaKind(file) {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "webm", "mov", "m4v", "mkv", "ogv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"].includes(ext)) return "audio";
  return null;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  document.body.appendChild(temp);
  temp.select();
  document.execCommand("copy");
  document.body.removeChild(temp);
}

function showToast(message, variant = "default") {
  const toast = document.createElement("div");
  toast.className = `toast ${variant === "error" ? "is-error" : variant === "success" ? "is-success" : ""}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 200ms ease";
    setTimeout(() => toast.remove(), 220);
  }, 3000);
}

function flashCopiedButton(button, originalLabel = "Copy Link") {
  button.classList.add("copied");
  button.textContent = "Copied!";
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.classList.remove("copied");
    button.textContent = originalLabel;
  }, 1800);
}

/* ==========================================================================
   SINGLE & BATCH UPLOAD FLOW (DIRECT TO CLOUDFLARE R2)
   ========================================================================== */
async function handleFilesSelected(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  if (!isApiConfigured()) {
    showToast("Set API_BASE_URL at the top of app.js to your Cloudflare Worker URL first.", "error");
    return;
  }

  dom.uploadQueueSection.classList.remove("hidden");
  updateQueueCounter();

  const tasks = files.map((file) => processSingleUpload(file));
  await Promise.allSettled(tasks);

  setTimeout(() => {
    if (dom.uploadQueueList.children.length === 0) {
      dom.uploadQueueSection.classList.add("hidden");
    }
    updateQueueCounter();
  }, 600);
}

function createUploadQueueRow(fileName) {
  const row = document.createElement("div");
  row.className = "upload-row";

  const top = document.createElement("div");
  top.className = "upload-row-top";

  const nameEl = document.createElement("span");
  nameEl.className = "upload-row-name";
  nameEl.textContent = fileName;

  const statusEl = document.createElement("span");
  statusEl.className = "upload-row-status";
  statusEl.textContent = "Preparing...";

  const track = document.createElement("div");
  track.className = "progress-track";

  const fill = document.createElement("div");
  fill.className = "progress-fill";

  track.appendChild(fill);
  top.append(nameEl, statusEl);
  row.append(top, track);
  dom.uploadQueueList.prepend(row);
  updateQueueCounter();

  return {
    setProgress(percent, label) {
      fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      statusEl.textContent = label || `${Math.round(percent)}%`;
    },
    setError(message) {
      row.classList.add("is-error");
      fill.style.width = "100%";
      statusEl.textContent = message;
    },
    remove(delayMs = 500) {
      setTimeout(() => {
        row.remove();
        updateQueueCounter();
        if (dom.uploadQueueList.children.length === 0) {
          dom.uploadQueueSection.classList.add("hidden");
        }
      }, delayMs);
    }
  };
}

function updateQueueCounter() {
  dom.queueCount.textContent = String(dom.uploadQueueList.children.length);
}

async function processSingleUpload(file) {
  const ui = createUploadQueueRow(file.name);
  const mediaKind = detectMediaKind(file);

  if (!mediaKind) {
    ui.setError("Unsupported file");
    showToast(`Skipped "${file.name}" — video or audio files only.`, "error");
    ui.remove(2600);
    return;
  }

  const contentType = file.type || (mediaKind === "video" ? "video/mp4" : "audio/mpeg");

  try {
    ui.setProgress(3, "Preparing...");

    // 1. Request presigned PUT URL from Worker
    const { clip, uploadUrl } = await R2Service.initUpload({
      name: file.name,
      type: contentType,
      mediaKind,
      size: file.size
    });

    // 2. Upload file directly to Cloudflare R2 with real progress
    await R2Service.uploadDirectToR2(uploadUrl, file, contentType, (pct) => {
      const scaled = 5 + pct * 0.9; // 5% -> 95%
      ui.setProgress(scaled, `${Math.round(pct)}%`);
    });

    // 3. Finalize clip metadata on Worker
    ui.setProgress(98, "Finalizing...");
    const finalizedClip = await R2Service.completeUpload(clip.id, clip.deleteToken);

    ui.setProgress(100, "Ready");
    state.clips.unshift(finalizedClip);
    LocalHistory.save(state.clips);
    renderClipList();
    ui.remove(500);
  } catch (err) {
    console.error("Upload failed:", err);
    ui.setError("Failed");
    showToast(err.message || `Failed to upload "${file.name}".`, "error");
    ui.remove(3200);
  }
}

/* ==========================================================================
   CLIP LIST RENDERING
   ========================================================================== */
function renderClipList() {
  const now = Date.now();
  state.clips = state.clips
    .filter((clip) => clip.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);

  LocalHistory.save(state.clips);

  dom.activeCount.textContent = String(state.clips.length);
  dom.emptyState.classList.toggle("hidden", state.clips.length > 0);
  dom.copyAllBtn.classList.toggle("hidden", state.clips.length < 2);
  dom.clearAllBtn.classList.toggle("hidden", state.clips.length === 0);

  dom.clipList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const clip of state.clips) {
    fragment.appendChild(createClipCard(clip));
  }

  dom.clipList.appendChild(fragment);
}

function createClipCard(clip) {
  const shareUrl = buildShareUrl(clip.id);
  const remaining = clip.expiresAt - Date.now();
  const isAudio = clip.mediaKind === "audio";

  const card = document.createElement("article");
  card.className = "clip-card";
  card.dataset.clipId = clip.id;

  const top = document.createElement("div");
  top.className = "clip-top";

  const info = document.createElement("div");
  info.className = "clip-info";

  const icon = document.createElement("div");
  icon.className = `clip-icon ${isAudio ? "is-audio" : ""}`;
  icon.innerHTML = isAudio
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><polygon points="10 9 15 12 10 15 10 9"></polygon></svg>`;

  const textWrap = document.createElement("div");
  textWrap.className = "clip-text";

  const name = document.createElement("h3");
  name.className = "clip-name";
  name.textContent = clip.name;
  name.title = clip.name;

  const submeta = document.createElement("div");
  submeta.className = "clip-submeta";

  const badge = document.createElement("span");
  badge.className = `media-badge ${isAudio ? "is-audio" : ""}`;
  badge.textContent = isAudio ? "Audio" : "Video";

  const sizeEl = document.createElement("span");
  sizeEl.textContent = formatBytes(clip.size);

  submeta.append(badge, sizeEl);
  textWrap.append(name, submeta);
  info.append(icon, textWrap);

  const countdownChip = document.createElement("div");
  countdownChip.className = `countdown-chip ${getUrgencyClass(remaining)}`.trim();
  countdownChip.dataset.countdownFor = clip.id;
  countdownChip.title = "Time remaining before automatic deletion";
  countdownChip.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
    <span class="countdown-text">${formatCountdown(remaining)}</span>
  `;

  top.append(info, countdownChip);

  const bottom = document.createElement("div");
  bottom.className = "clip-bottom";

  const inputGroup = document.createElement("div");
  inputGroup.className = "share-input-group";

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.className = "share-url-input";
  urlInput.value = shareUrl;
  urlInput.readOnly = true;
  urlInput.setAttribute("aria-label", `Shareable link for ${clip.name}`);
  urlInput.addEventListener("click", () => urlInput.select());

  inputGroup.appendChild(urlInput);

  const actions = document.createElement("div");
  actions.className = "clip-actions";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-primary";
  copyBtn.textContent = "Copy Link";
  copyBtn.addEventListener("click", async () => {
    try {
      await copyTextToClipboard(shareUrl);
      flashCopiedButton(copyBtn, "Copy Link");
    } catch {
      showToast("Failed to copy link.", "error");
    }
  });

  const openBtn = document.createElement("a");
  openBtn.className = "btn btn-secondary";
  openBtn.href = `#clip=${encodeURIComponent(clip.id)}`;
  openBtn.textContent = "Open";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn-danger-ghost btn-icon";
  deleteBtn.title = "Delete clip immediately from Cloudflare R2";
  deleteBtn.setAttribute("aria-label", `Delete ${clip.name}`);
  deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;
  deleteBtn.addEventListener("click", () => deleteClipById(clip.id, true));

  actions.append(copyBtn, openBtn, deleteBtn);
  bottom.append(inputGroup, actions);

  card.append(top, bottom);
  return card;
}

/* ==========================================================================
   DEDICATED CROSS-DEVICE VIEWER ROUTING
   ========================================================================== */
function cleanupViewerMedia() {
  const mediaEl = dom.viewerMediaStage.querySelector("video, audio");
  if (mediaEl) {
    mediaEl.pause();
    mediaEl.removeAttribute("src");
    mediaEl.load();
  }
  dom.viewerMediaStage.innerHTML = "";
}

async function handleRouteChange() {
  const clipId = getClipIdFromHash();
  cleanupViewerMedia();

  if (!clipId) {
    state.activeViewerClipId = null;
    dom.viewerView.classList.add("hidden");
    dom.uploaderView.classList.remove("hidden");
    state.clips = LocalHistory.load();
    renderClipList();
    return;
  }

  state.activeViewerClipId = clipId;
  dom.uploaderView.classList.add("hidden");
  dom.viewerView.classList.remove("hidden");
  dom.viewerCard.classList.add("hidden");
  dom.viewerExpiredCard.classList.add("hidden");

  if (!isApiConfigured()) {
    showViewerExpired(
      "Backend not configured",
      "Set API_BASE_URL at the top of app.js to your Cloudflare Worker URL."
    );
    return;
  }

  try {
    const result = await R2Service.fetchClipForViewer(clipId);
    // Abort if user navigated away during fetch
    if (state.activeViewerClipId !== clipId) return;

    if (!result || Date.now() >= result.clip.expiresAt) {
      showViewerExpired(
        "This clip has expired",
        "Its retention timer reached zero and the file was deleted, or the link is invalid."
      );
      return;
    }

    renderActiveViewer(result.clip, result.mediaUrl);
  } catch (err) {
    console.error("Viewer fetch error:", err);
    showViewerExpired(
      "Unable to load clip",
      err.message || "Could not connect to the storage server."
    );
  }
}

function renderActiveViewer(clip, mediaUrl) {
  dom.viewerExpiredCard.classList.add("hidden");
  dom.viewerCard.classList.remove("hidden");

  const isAudio = clip.mediaKind === "audio";
  const remaining = clip.expiresAt - Date.now();

  dom.viewerTypeBadge.textContent = isAudio ? "Audio" : "Video";
  dom.viewerTypeBadge.className = `media-badge ${isAudio ? "is-audio" : ""}`;
  dom.viewerFileName.textContent = clip.name;
  dom.viewerMeta.textContent = `${formatBytes(clip.size)} • Uploaded ${new Date(clip.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  dom.viewerCountdown.textContent = formatCountdown(remaining);
  dom.viewerTimerBox.className = `viewer-timer-box ${getUrgencyClass(remaining)}`.trim();
  dom.viewerTimerBox.dataset.expiresAt = String(clip.expiresAt);

  dom.viewerShareUrl.value = buildShareUrl(clip.id);

  if (isAudio) {
    const wrapper = document.createElement("div");
    wrapper.className = "audio-stage-box";
    wrapper.innerHTML = `
      <div class="audio-wave-badge" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      </div>
    `;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = mediaUrl;
    wrapper.appendChild(audio);
    dom.viewerMediaStage.appendChild(wrapper);
  } else {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = mediaUrl;
    dom.viewerMediaStage.appendChild(video);
  }
}

function showViewerExpired(title, message) {
  cleanupViewerMedia();
  dom.viewerCard.classList.add("hidden");
  dom.viewerExpiredCard.classList.remove("hidden");
  dom.expiredTitle.textContent = title;
  dom.expiredMessage.textContent = message;
}

/* ==========================================================================
   LIVE COUNTDOWN TICKER & DELETION
   ========================================================================== */
async function deleteClipById(id, notify = false) {
  const clip = state.clips.find((c) => c.id === id);
  const card = dom.clipList.querySelector(`[data-clip-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add("removing");

  try {
    if (clip?.deleteToken && isApiConfigured()) {
      await R2Service.deleteClip(id, clip.deleteToken);
    }
  } catch (err) {
    console.error("Remote delete error:", err);
    if (card) card.classList.remove("removing");
    showToast(err.message || "Could not delete clip from R2.", "error");
    return;
  }

  state.clips = state.clips.filter((c) => c.id !== id);
  LocalHistory.save(state.clips);

  if (state.activeViewerClipId === id) {
    showViewerExpired(
      "This clip has expired",
      "The clip has been deleted and access is revoked."
    );
  }

  setTimeout(() => renderClipList(), card ? 220 : 0);
  if (notify) showToast("Clip permanently deleted from R2.", "success");
}

function startCountdownTicker() {
  if (state.tickerId) clearInterval(state.tickerId);

  state.tickerId = setInterval(() => {
    const now = Date.now();

    // 1. Update uploader dashboard cards
    for (const clip of [...state.clips]) {
      const remaining = clip.expiresAt - now;
      if (remaining <= 0) {
        deleteClipById(clip.id, false);
        showToast(`"${clip.name}" expired and was removed.`);
        continue;
      }

      const chip = dom.clipList.querySelector(`[data-countdown-for="${CSS.escape(clip.id)}"]`);
      if (chip) {
        const textNode = chip.querySelector(".countdown-text");
        if (textNode) textNode.textContent = formatCountdown(remaining);
        chip.className = `countdown-chip ${getUrgencyClass(remaining)}`.trim();
      }
    }

    // 2. Update active viewer countdown
    if (state.activeViewerClipId && !dom.viewerCard.classList.contains("hidden")) {
      const expiresAt = Number(dom.viewerTimerBox.dataset.expiresAt || 0);
      const remaining = expiresAt - now;

      if (remaining <= 0) {
        showViewerExpired(
          "This clip has expired",
          "The countdown reached zero and this link is no longer valid."
        );
      } else {
        dom.viewerCountdown.textContent = formatCountdown(remaining);
        dom.viewerTimerBox.className = `viewer-timer-box ${getUrgencyClass(remaining)}`.trim();
      }
    }
  }, 1000);
}

/* ==========================================================================
   EVENT LISTENERS & INITIALIZATION
   ========================================================================== */
function bindEvents() {
  dom.dropZone.addEventListener("click", () => dom.fileInput.click());

  dom.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dom.fileInput.click();
    }
  });

  dom.fileInput.addEventListener("change", (e) => {
    handleFilesSelected(e.target.files);
    e.target.value = "";
  });

  ["dragenter", "dragover"].forEach((evtName) => {
    dom.dropZone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropZone.classList.add("drag-active");
    });
  });

  ["dragleave", "drop"].forEach((evtName) => {
    dom.dropZone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropZone.classList.remove("drag-active");
    });
  });

  dom.dropZone.addEventListener("drop", (e) => {
    handleFilesSelected(e.dataTransfer?.files);
  });

  dom.copyAllBtn.addEventListener("click", async () => {
    const allLinks = state.clips
      .map((clip) => `${clip.name}: ${buildShareUrl(clip.id)}`)
      .join("\n");

    try {
      await copyTextToClipboard(allLinks);
      showToast(`Copied ${state.clips.length} links to clipboard.`, "success");
    } catch {
      showToast("Failed to copy links.", "error");
    }
  });

  dom.clearAllBtn.addEventListener("click", async () => {
    const toDelete = [...state.clips];
    await Promise.allSettled(
      toDelete.map((clip) => R2Service.deleteClip(clip.id, clip.deleteToken))
    );
    state.clips = [];
    LocalHistory.save([]);
    renderClipList();
    showToast("All clips permanently deleted.", "success");
  });

  const goHome = (e) => {
    if (e) e.preventDefault();
    window.location.hash = "";
  };

  dom.brandLink.addEventListener("click", goHome);
  dom.backToUploaderBtn.addEventListener("click", goHome);
  dom.expiredHomeBtn.addEventListener("click", goHome);

  dom.viewerShareUrl.addEventListener("click", () => dom.viewerShareUrl.select());

  dom.viewerCopyBtn.addEventListener("click", async () => {
    try {
      await copyTextToClipboard(dom.viewerShareUrl.value);
      flashCopiedButton(dom.viewerCopyBtn, "Copy Link");
    } catch {
      showToast("Failed to copy link.", "error");
    }
  });

  window.addEventListener("hashchange", handleRouteChange);
}

async function init() {
  dom.retentionLabel.textContent = formatRetentionHeader(EXPIRATION_MINUTES);
  bindEvents();
  state.clips = LocalHistory.load();
  renderClipList();
  await handleRouteChange();
  startCountdownTicker();
}

document.addEventListener("DOMContentLoaded", init);