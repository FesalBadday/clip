/* ==========================================================================
   CONFIGURATION
   1. EXPIRATION_MINUTES: Default clip lifetime in minutes (180 = 3 hours).
   2. API_BASE_URL: Your deployed Cloudflare Worker URL (no trailing slash).
   ========================================================================== */
const EXPIRATION_MINUTES = 180;
const API_BASE_URL = "https://clipvault-api.faisal-n04.workers.dev";

const GB = 1000 * 1000 * 1000; // Decimal GB to match Cloudflare R2 billing
const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 270;
const TAB_SYNC_COOLDOWN_MS = 15000;
const LEGACY_LOCAL_LIST_KEY = "clipvault_my_clips_v1";
const PASSCODE_STORAGE_KEY = "clipvault_upload_passcode";

/* ==========================================================================
   STATE & DOM REFERENCES
   ========================================================================== */
const state = {
  clips: [],
  loadingClips: false,
  lastSyncAt: 0,
  activeViewerClipId: null,
  isUnlocked: false,
  passcode: "",
  tickerId: null
};

const dom = {
  brandLink: document.getElementById("brandLink"),
  retentionLabel: document.getElementById("retentionLabel"),

  uploaderView: document.getElementById("uploaderView"),

  authBar: document.getElementById("authBar"),
  authLockedState: document.getElementById("authLockedState"),
  authUnlockedState: document.getElementById("authUnlockedState"),
  passcodeForm: document.getElementById("passcodeForm"),
  passcodeInput: document.getElementById("passcodeInput"),
  unlockBtn: document.getElementById("unlockBtn"),
  authError: document.getElementById("authError"),
  lockBtn: document.getElementById("lockBtn"),

  storageBar: document.getElementById("storageBar"),
  storageReservedPill: document.getElementById("storageReservedPill"),
  storageUsageText: document.getElementById("storageUsageText"),
  storagePercentText: document.getElementById("storagePercentText"),
  storageProgressBar: document.getElementById("storageProgressBar"),
  storageProgressFill: document.getElementById("storageProgressFill"),
  storageSubtext: document.getElementById("storageSubtext"),
  refreshStorageBtn: document.getElementById("refreshStorageBtn"),

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
   PASSCODE LOCK BAR & AUTHENTICATION (UPLOADER ONLY)
   ========================================================================== */
function getStoredPasscode() {
  try {
    return localStorage.getItem(PASSCODE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveStoredPasscode(code) {
  try {
    localStorage.setItem(PASSCODE_STORAGE_KEY, code);
  } catch {
    // Ignore storage restrictions
  }
}

function clearStoredPasscode() {
  try {
    localStorage.removeItem(PASSCODE_STORAGE_KEY);
  } catch {
    // Ignore storage restrictions
  }
}

function showAuthError(message) {
  dom.authError.textContent = message;
  dom.authError.classList.remove("hidden");
  dom.authBar.classList.remove("is-shaking");
  void dom.authBar.offsetWidth;
  dom.authBar.classList.add("is-shaking");
}

function clearAuthError() {
  dom.authError.textContent = "";
  dom.authError.classList.add("hidden");
}

function setUploaderUnlocked(unlocked, passcode = "") {
  state.isUnlocked = unlocked;
  state.passcode = unlocked ? passcode : "";

  dom.authBar.classList.toggle("is-unlocked", unlocked);
  dom.authLockedState.classList.toggle("hidden", unlocked);
  dom.authUnlockedState.classList.toggle("hidden", !unlocked);
  dom.storageBar.classList.toggle("hidden", !unlocked);

  dom.dropZone.classList.toggle("is-locked", !unlocked);
  dom.dropZone.setAttribute("aria-disabled", String(!unlocked));

  if (unlocked) {
    clearAuthError();
    dom.passcodeInput.value = "";
  } else {
    state.clips = [];
    state.loadingClips = false;
    renderClipList();
  }
}

function promptUnlockFocus(notice) {
  dom.authBar.classList.add("is-attention");
  setTimeout(() => dom.authBar.classList.remove("is-attention"), 900);
  if (notice) showAuthError(notice);
  dom.passcodeInput.focus();
}

function lockUploader(toastMessage = "Uploader locked.") {
  clearStoredPasscode();
  setUploaderUnlocked(false);
  if (toastMessage) showToast(toastMessage);
}

async function verifyAndUnlock(code, { silent = false } = {}) {
  const trimmed = (code || "").trim();
  if (!trimmed) {
    if (!silent) showAuthError("Please enter your upload passcode.");
    return false;
  }

  dom.unlockBtn.disabled = true;
  dom.unlockBtn.textContent = "Verifying...";
  clearAuthError();

  try {
    const ok = await R2Service.verifyPasscode(trimmed);
    if (!ok) {
      clearStoredPasscode();
      setUploaderUnlocked(false);
      if (!silent) {
        showAuthError("Incorrect passcode. Try again.");
        dom.passcodeInput.focus();
        dom.passcodeInput.select();
      }
      return false;
    }

    saveStoredPasscode(trimmed);
    setUploaderUnlocked(true, trimmed);
    syncDashboardFromR2();
    if (!silent) showToast("Uploader unlocked.", "success");
    return true;
  } catch (err) {
    console.error("Passcode verification failed:", err);
    setUploaderUnlocked(false);
    if (!silent) {
      showAuthError(err.message || "Could not reach server to verify passcode.");
    }
    return false;
  } finally {
    dom.unlockBtn.disabled = false;
    dom.unlockBtn.textContent = "Unlock";
  }
}

/* ==========================================================================
   AUTOMATIC VIDEO THUMBNAIL & DURATION EXTRACTION
   ========================================================================== */
function extractMediaMetadata(file, mediaKind) {
  if (mediaKind === "audio") {
    return extractAudioDuration(file);
  }
  return extractVideoThumbnailAndDuration(file);
}

function extractAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (duration) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
      resolve({
        duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        thumbnail: null
      });
    };

    const timeoutId = setTimeout(() => finish(null), 3500);

    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(null);
    audio.src = objectUrl;
  });
}

function extractVideoThumbnailAndDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const cleanup = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    const captureFrame = () => {
      if (!video.videoWidth || !video.videoHeight) return null;

      try {
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_WIDTH;
        canvas.height = THUMB_HEIGHT;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const videoRatio = vw / vh;

        ctx.fillStyle = "#07080d";
        ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);

        if (videoRatio < 1.25) {
          // Portrait or square clip: dimmed ambient backdrop + crisp centered video
          const coverScale = Math.max(THUMB_WIDTH / vw, THUMB_HEIGHT / vh);
          const cw = vw * coverScale;
          const ch = vh * coverScale;
          ctx.save();
          ctx.filter = "blur(14px) brightness(0.42)";
          ctx.drawImage(video, (THUMB_WIDTH - cw) / 2, (THUMB_HEIGHT - ch) / 2, cw, ch);
          ctx.restore();
          ctx.fillStyle = "rgba(7, 8, 13, 0.35)";
          ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);

          const fitScale = Math.min(THUMB_WIDTH / vw, THUMB_HEIGHT / vh);
          const fw = vw * fitScale;
          const fh = vh * fitScale;
          ctx.drawImage(video, (THUMB_WIDTH - fw) / 2, (THUMB_HEIGHT - fh) / 2, fw, fh);
        } else {
          // Landscape clip: full 16:9 cover crop like YouTube
          const scale = Math.max(THUMB_WIDTH / vw, THUMB_HEIGHT / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          ctx.drawImage(video, (THUMB_WIDTH - dw) / 2, (THUMB_HEIGHT - dh) / 2, dw, dh);
        }

        let dataUrl = canvas.toDataURL("image/jpeg", 0.72);
        if (dataUrl.length > 105000) {
          dataUrl = canvas.toDataURL("image/jpeg", 0.55);
        }
        return dataUrl.length <= 115000 ? dataUrl : null;
      } catch {
        return null;
      }
    };

    const finish = (thumbnail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const duration =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.round(video.duration)
          : null;
      cleanup();
      resolve({ duration, thumbnail });
    };

    const timeoutId = setTimeout(() => {
      const fallbackFrame = video.readyState >= 2 ? captureFrame() : null;
      finish(fallbackFrame);
    }, 4500);

    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    video.onloadedmetadata = () => {
      const dur = video.duration;
      const targetTime =
        Number.isFinite(dur) && dur > 0.5 ? Math.min(dur * 0.2, 3) : 0;

      if (targetTime > 0) {
        try {
          video.currentTime = targetTime;
        } catch {
          // Fall through to onloadeddata
        }
      }
    };

    video.onseeked = () => {
      finish(captureFrame());
    };

    video.onloadeddata = () => {
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0.5) {
        finish(captureFrame());
      }
    };

    video.onerror = () => finish(null);
    video.src = objectUrl;
  });
}

/* ==========================================================================
   CLOUD-SYNCED DASHBOARD (CLIPS + LIVE R2 STORAGE USAGE)
   ========================================================================== */
function formatGigabytes(bytes) {
  return (Math.max(0, bytes) / GB).toFixed(2);
}

function renderStorageUsage(data) {
  const usedBytes = Number(data.usedBytes || 0);
  const reservedBytes = Number(data.reservedBytes || 0);
  const maxBytes = Number(data.maxBytes || 9 * GB);
  const storedCount = Number(data.storedCount || 0);
  const reservedCount = Number(data.reservedCount || 0);

  const percent = maxBytes > 0 ? Math.min(100, (usedBytes / maxBytes) * 100) : 0;
  const remainingBytes = Math.max(0, maxBytes - usedBytes);

  dom.storageUsageText.textContent = `${formatGigabytes(usedBytes)} / ${formatGigabytes(maxBytes)} GB`;
  dom.storagePercentText.textContent = `${Math.round(percent)}%`;
  dom.storageProgressFill.style.width = `${percent.toFixed(1)}%`;
  dom.storageProgressBar.setAttribute("aria-valuenow", String(Math.round(percent)));

  dom.storageBar.classList.remove("is-warning", "is-critical");
  if (percent >= 90) {
    dom.storageBar.classList.add("is-critical");
  } else if (percent >= 70) {
    dom.storageBar.classList.add("is-warning");
  }

  if (reservedBytes > 0) {
    dom.storageReservedPill.textContent = `${formatBytes(reservedBytes)} uploading`;
    dom.storageReservedPill.classList.remove("hidden");
  } else {
    dom.storageReservedPill.classList.add("hidden");
  }

  const clipWord = storedCount === 1 ? "clip" : "clips";
  const inFlightNote = reservedCount > 0 ? ` • ${reservedCount} in progress` : "";
  dom.storageSubtext.textContent = `${formatGigabytes(remainingBytes)} GB available • ${storedCount} stored ${clipWord} in R2${inFlightNote}`;
}

async function refreshStorageUsage() {
  if (!state.isUnlocked || !state.passcode || !isApiConfigured()) return;

  try {
    const usage = await R2Service.fetchStorageUsage(state.passcode);
    if (!state.isUnlocked) return;
    renderStorageUsage(usage);
  } catch (err) {
    if (err.status === 401) {
      lockUploader("");
      promptUnlockFocus("Passcode rejected. Please unlock again.");
      return;
    }
    console.error("Storage usage check failed:", err);
    dom.storageSubtext.textContent = "Unable to load live storage usage right now.";
  }
}

async function syncActiveClipsFromR2() {
  if (!state.isUnlocked || !state.passcode || !isApiConfigured()) return;

  state.loadingClips = true;
  if (state.clips.length === 0) renderClipList();

  try {
    const clips = await R2Service.fetchAllClips(state.passcode);
    if (!state.isUnlocked) return;
    state.clips = clips;
  } catch (err) {
    if (err.status === 401) {
      lockUploader("");
      promptUnlockFocus("Passcode rejected. Please unlock again.");
      return;
    }
    console.error("Clip list sync failed:", err);
    showToast("Could not sync active clips from R2.", "error");
  } finally {
    state.loadingClips = false;
    renderClipList();
  }
}

async function syncDashboardFromR2({ showSpinner = false } = {}) {
  if (!state.isUnlocked || !state.passcode || !isApiConfigured()) return;
  state.lastSyncAt = Date.now();
  if (showSpinner) dom.refreshStorageBtn.classList.add("is-spinning");

  try {
    await Promise.all([refreshStorageUsage(), syncActiveClipsFromR2()]);
  } finally {
    if (showSpinner) dom.refreshStorageBtn.classList.remove("is-spinning");
  }
}

/* ==========================================================================
   CLOUDFLARE R2 API SERVICE
   ========================================================================== */
function getApiBase() {
  return API_BASE_URL.replace(/\/+$/, "");
}

function isApiConfigured() {
  return Boolean(API_BASE_URL) && !API_BASE_URL.includes("YOUR-WORKER-NAME");
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const R2Service = {
  async verifyPasscode(passcode) {
    const res = await fetch(`${getApiBase()}/api/auth/verify`, {
      method: "POST",
      headers: {
        "X-Upload-Passcode": passcode
      }
    });
    if (res.status === 401) return false;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Auth check failed (${res.status})`, res.status);
    return Boolean(data.ok);
  },

  async fetchStorageUsage(passcode) {
    const res = await fetch(`${getApiBase()}/api/storage`, {
      method: "GET",
      headers: {
        "X-Upload-Passcode": passcode
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Storage check failed (${res.status})`, res.status);
    return data;
  },

  async fetchAllClips(passcode) {
    const res = await fetch(`${getApiBase()}/api/clips`, {
      method: "GET",
      headers: {
        "X-Upload-Passcode": passcode
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Clip sync failed (${res.status})`, res.status);
    return Array.isArray(data.clips) ? data.clips : [];
  },

  async initUpload({ name, type, mediaKind, size, duration, thumbnail }, passcode) {
    const res = await fetch(`${getApiBase()}/api/clips/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Passcode": passcode
      },
      body: JSON.stringify({
        name,
        type,
        mediaKind,
        size,
        duration,
        thumbnail,
        expirationMinutes: EXPIRATION_MINUTES
      })
    });

    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      lockUploader("");
      promptUnlockFocus("Passcode rejected. Please unlock again.");
      throw new ApiError("Upload passcode rejected.", 401);
    }
    if (!res.ok) {
      throw new ApiError(data.error || `Init failed (${res.status})`, res.status);
    }
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
          reject(new ApiError(`R2 upload failed (${xhr.status})`, xhr.status));
        }
      });

      xhr.addEventListener("error", () => {
        reject(new ApiError("Upload blocked — check R2 bucket CORS policy.", 0));
      });

      xhr.addEventListener("abort", () => {
        reject(new ApiError("Upload cancelled.", 0));
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
    if (!res.ok) throw new ApiError(data.error || `Finalize failed (${res.status})`, res.status);
    return data.clip;
  },

  async fetchClipForViewer(id) {
    const res = await fetch(`${getApiBase()}/api/clips/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Could not load clip (${res.status})`, res.status);
    return data; // { clip, mediaUrl }
  },

  async markClipWatched(id, ownerPasscode = "") {
    const headers = {};
    if (ownerPasscode) headers["X-Upload-Passcode"] = ownerPasscode;

    // Best-effort fire-and-forget ping; never disrupt playback on failure
    await fetch(`${getApiBase()}/api/clips/${encodeURIComponent(id)}/watched`, {
      method: "POST",
      headers,
      keepalive: true
    }).catch(() => { });
  },

  async deleteClip(id, { passcode = "", deleteToken = "" } = {}) {
    const headers = {};
    if (passcode) headers["X-Upload-Passcode"] = passcode;
    if (deleteToken) headers["X-Delete-Token"] = deleteToken;

    const res = await fetch(`${getApiBase()}/api/clips/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers
    });
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data.error || `Delete failed (${res.status})`, res.status);
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
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / Math.pow(1000, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const secs = Math.floor(totalSeconds);
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const rem = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(rem)}` : `${mins}:${pad(rem)}`;
}

function formatShortTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
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
  }, 3200);
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
   SINGLE & BATCH UPLOAD FLOW (THUMBNAIL + SERIALIZED RESERVATION + R2 PUT)
   ========================================================================== */
let reservationChain = Promise.resolve();

function enqueueReservation(taskFn) {
  const run = reservationChain.then(taskFn, taskFn);
  reservationChain = run.catch(() => { });
  return run;
}

async function handleFilesSelected(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  if (!isApiConfigured()) {
    showToast("Set API_BASE_URL at the top of app.js to your Cloudflare Worker URL first.", "error");
    return;
  }

  if (!state.isUnlocked || !state.passcode) {
    promptUnlockFocus("Enter your upload passcode above before uploading clips.");
    return;
  }

  dom.uploadQueueSection.classList.remove("hidden");
  updateQueueCounter();

  const entries = files.map((file) => ({
    file,
    ui: createUploadQueueRow(file.name)
  }));

  const activePasscode = state.passcode;
  const uploadTasks = [];
  let authFailed = false;

  for (const { file, ui } of entries) {
    if (authFailed) {
      ui.setError("Locked");
      ui.remove(2000);
      continue;
    }

    const mediaKind = detectMediaKind(file);
    if (!mediaKind) {
      ui.setError("Unsupported file");
      showToast(`Skipped "${file.name}" — video or audio files only.`, "error");
      ui.remove(2600);
      continue;
    }

    const contentType = file.type || (mediaKind === "video" ? "video/mp4" : "audio/mpeg");

    try {
      ui.setProgress(2, mediaKind === "video" ? "Creating thumbnail..." : "Reading audio...");
      const { duration, thumbnail } = await extractMediaMetadata(file, mediaKind);

      ui.setProgress(4, "Reserving...");
      const reservation = await enqueueReservation(() =>
        R2Service.initUpload(
          {
            name: file.name,
            type: contentType,
            mediaKind,
            size: file.size,
            duration,
            thumbnail
          },
          activePasscode
        )
      );

      refreshStorageUsage();

      uploadTasks.push(
        uploadReservedFile({
          file,
          contentType,
          clip: reservation.clip,
          uploadUrl: reservation.uploadUrl,
          passcode: activePasscode,
          ui
        })
      );
    } catch (err) {
      console.error("Reservation failed:", err);
      if (err.status === 401) {
        authFailed = true;
        ui.setError("Passcode rejected");
      } else if (err.status === 507) {
        ui.setError("9 GB cap reached");
        refreshStorageUsage();
      } else {
        ui.setError("Failed");
      }
      showToast(err.message || `Could not start "${file.name}".`, "error");
      ui.remove(3600);
    }
  }

  await Promise.allSettled(uploadTasks);
  refreshStorageUsage();

  setTimeout(() => {
    if (dom.uploadQueueList.children.length === 0) {
      dom.uploadQueueSection.classList.add("hidden");
    }
    updateQueueCounter();
  }, 600);
}

async function uploadReservedFile({ file, contentType, clip, uploadUrl, passcode, ui }) {
  try {
    await R2Service.uploadDirectToR2(uploadUrl, file, contentType, (pct) => {
      const scaled = 5 + pct * 0.9; // 5% -> 95%
      ui.setProgress(scaled, `${Math.round(pct)}%`);
    });

    ui.setProgress(98, "Finalizing...");
    const finalizedClip = await R2Service.completeUpload(clip.id, clip.deleteToken);

    ui.setProgress(100, "Ready");
    if (state.isUnlocked) {
      state.clips = [finalizedClip, ...state.clips.filter((c) => c.id !== finalizedClip.id)];
      renderClipList();
      refreshStorageUsage();
    }
    ui.remove(500);
  } catch (err) {
    console.error("Upload failed:", err);
    ui.setError("Upload failed");
    showToast(err.message || `Failed to upload "${file.name}".`, "error");

    await R2Service.deleteClip(clip.id, {
      passcode,
      deleteToken: clip.deleteToken
    }).catch(() => { });
    refreshStorageUsage();
    ui.remove(3200);
  }
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
  statusEl.textContent = "Queued...";

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

/* ==========================================================================
   YOUTUBE-STYLE CLIP GRID RENDERING (WITH WATCHED STATUS)
   ========================================================================== */
function setEmptyStateMessage(message) {
  const p = dom.emptyState.querySelector("p");
  if (p) p.textContent = message;
}

function renderClipList() {
  if (!state.isUnlocked) {
    dom.activeCount.textContent = "0";
    dom.copyAllBtn.classList.add("hidden");
    dom.clearAllBtn.classList.add("hidden");
    dom.clipList.innerHTML = "";
    setEmptyStateMessage("Unlock the uploader above to view and manage your active clips.");
    dom.emptyState.classList.remove("hidden");
    return;
  }

  const now = Date.now();
  state.clips = state.clips
    .filter((clip) => clip.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);

  dom.activeCount.textContent = String(state.clips.length);
  dom.copyAllBtn.classList.toggle("hidden", state.clips.length < 2);
  dom.clearAllBtn.classList.toggle("hidden", state.clips.length === 0);

  if (state.clips.length === 0) {
    dom.clipList.innerHTML = "";
    setEmptyStateMessage(
      state.loadingClips
        ? "Syncing active clips from R2..."
        : "No active clips in R2. Upload video or audio files above to generate shareable links."
    );
    dom.emptyState.classList.remove("hidden");
    return;
  }

  dom.emptyState.classList.add("hidden");
  dom.clipList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const clip of state.clips) {
    fragment.appendChild(createClipCard(clip));
  }

  dom.clipList.appendChild(fragment);
}

function createClipCard(clip) {
  const shareUrl = buildShareUrl(clip.id);
  const clipHash = `#clip=${encodeURIComponent(clip.id)}`;
  const remaining = clip.expiresAt - Date.now();
  const isAudio = clip.mediaKind === "audio";
  const durationLabel = formatDuration(clip.duration);
  const isWatched = Boolean(clip.watched);
  const watchCount = Number(clip.watchCount || 0);

  const card = document.createElement("article");
  card.className = `clip-card ${isWatched ? "is-watched" : ""}`.trim();
  card.dataset.clipId = clip.id;

  // 1. Clickable 16:9 Thumbnail Area
  const thumbLink = document.createElement("a");
  thumbLink.className = "thumb-link";
  thumbLink.href = clipHash;
  thumbLink.setAttribute("aria-label", `Play ${clip.name}`);

  if (!isAudio && clip.thumbnail) {
    const img = document.createElement("img");
    img.className = "thumb-img";
    img.src = clip.thumbnail;
    img.alt = `Thumbnail for ${clip.name}`;
    img.loading = "lazy";
    thumbLink.appendChild(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = `thumb-placeholder ${isAudio ? "is-audio" : ""}`.trim();
    placeholder.innerHTML = isAudio
      ? `
        <div class="audio-bars" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <span class="thumb-placeholder-label">Audio Clip</span>
      `
      : `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2.5"></rect>
          <polygon points="10 9 15 12 10 15 10 9"></polygon>
        </svg>
        <span class="thumb-placeholder-label">Video Clip</span>
      `;
    thumbLink.appendChild(placeholder);
  }

  // Hover Play Overlay
  const playOverlay = document.createElement("div");
  playOverlay.className = "thumb-play-overlay";
  playOverlay.setAttribute("aria-hidden", "true");
  playOverlay.innerHTML = `
    <span class="thumb-play-circle">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="6 4 20 12 6 20 6 4"></polygon>
      </svg>
    </span>
  `;
  thumbLink.appendChild(playOverlay);

  // Live Countdown Pill (Top-Left of Thumbnail)
  const countdownPill = document.createElement("div");
  countdownPill.className = `thumb-countdown ${getUrgencyClass(remaining)}`.trim();
  countdownPill.dataset.countdownFor = clip.id;
  countdownPill.title = "Time remaining before automatic deletion";
  countdownPill.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
    <span class="countdown-text">${formatCountdown(remaining)}</span>
  `;
  thumbLink.appendChild(countdownPill);

  // Watched Badge (Top-Right of Thumbnail)
  if (isWatched) {
    const watchedPill = document.createElement("div");
    watchedPill.className = "thumb-watched";
    const watchedTime = clip.lastWatchedAt ? formatShortTime(clip.lastWatchedAt) : "";
    const countLabel = watchCount > 1 ? ` · ${watchCount}` : "";
    watchedPill.title = watchedTime
      ? `Watched by customer (${watchCount || 1}x, last at ${watchedTime})`
      : "Watched by customer";
    watchedPill.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span>Watched${countLabel}</span>
    `;
    thumbLink.appendChild(watchedPill);
  }

  // Video / Audio Duration Pill (Bottom-Right of Thumbnail)
  if (durationLabel) {
    const durBadge = document.createElement("span");
    durBadge.className = "thumb-duration";
    durBadge.textContent = durationLabel;
    thumbLink.appendChild(durBadge);
  }

  // 2. Card Details & Share Controls
  const body = document.createElement("div");
  body.className = "clip-body";

  const titleLink = document.createElement("a");
  titleLink.className = "clip-title-link";
  titleLink.href = clipHash;
  titleLink.textContent = clip.name;
  titleLink.title = clip.name;

  const submeta = document.createElement("div");
  submeta.className = "clip-submeta";

  const badge = document.createElement("span");
  badge.className = `media-badge ${isAudio ? "is-audio" : ""}`.trim();
  badge.textContent = isAudio ? "Audio" : "Video";

  const sizeEl = document.createElement("span");
  sizeEl.textContent = formatBytes(clip.size);

  const sep = document.createElement("span");
  sep.className = "meta-sep";
  sep.textContent = "•";

  const statusMeta = document.createElement("span");
  if (isWatched && clip.lastWatchedAt) {
    statusMeta.className = "watched-meta-text";
    statusMeta.textContent = `Watched ${formatShortTime(clip.lastWatchedAt)}`;
  } else if (isWatched) {
    statusMeta.className = "watched-meta-text";
    statusMeta.textContent = "Watched";
  } else {
    statusMeta.textContent = formatShortTime(clip.createdAt);
  }

  submeta.append(badge, sizeEl, sep, statusMeta);

  const shareStack = document.createElement("div");
  shareStack.className = "clip-share-stack";

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.className = "share-url-input";
  urlInput.value = shareUrl;
  urlInput.readOnly = true;
  urlInput.setAttribute("aria-label", `Shareable link for ${clip.name}`);
  urlInput.addEventListener("click", () => urlInput.select());

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

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn-danger-ghost btn-icon";
  deleteBtn.title = "Delete clip immediately from Cloudflare R2";
  deleteBtn.setAttribute("aria-label", `Delete ${clip.name}`);
  deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;
  deleteBtn.addEventListener("click", () => deleteClipById(clip.id, true));

  actions.append(copyBtn, deleteBtn);
  shareStack.append(urlInput, actions);
  body.append(titleLink, submeta, shareStack);

  card.append(thumbLink, body);
  return card;
}

/* ==========================================================================
   DEDICATED CROSS-DEVICE VIEWER ROUTING (PUBLIC — NO PASSCODE NEEDED)
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
    renderClipList();
    if (state.isUnlocked) syncDashboardFromR2();
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

function attachWatchedListener(mediaEl, clipId) {
  let reported = false;

  // Fires once playback actually starts (ignores link preview bots & owner previews)
  mediaEl.addEventListener("playing", () => {
    if (reported) return;
    reported = true;
    const ownerPasscode = state.passcode || getStoredPasscode();
    R2Service.markClipWatched(clipId, ownerPasscode);
  });
}

function renderActiveViewer(clip, mediaUrl) {
  dom.viewerExpiredCard.classList.add("hidden");
  dom.viewerCard.classList.remove("hidden");

  const isAudio = clip.mediaKind === "audio";
  const remaining = clip.expiresAt - Date.now();
  const durationLabel = formatDuration(clip.duration);

  dom.viewerTypeBadge.textContent = isAudio ? "Audio" : "Video";
  dom.viewerTypeBadge.className = `media-badge ${isAudio ? "is-audio" : ""}`.trim();
  dom.viewerFileName.textContent = clip.name;

  const metaParts = [formatBytes(clip.size)];
  if (durationLabel) metaParts.push(durationLabel);
  metaParts.push(`Uploaded ${formatShortTime(clip.createdAt)}`);
  dom.viewerMeta.textContent = metaParts.join(" • ");

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
    attachWatchedListener(audio, clip.id);
    wrapper.appendChild(audio);
    dom.viewerMediaStage.appendChild(wrapper);
  } else {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (clip.thumbnail) video.poster = clip.thumbnail;
    video.src = mediaUrl;
    attachWatchedListener(video, clip.id);
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
  const card = dom.clipList.querySelector(`[data-clip-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add("removing");

  try {
    if (state.isUnlocked && state.passcode && isApiConfigured()) {
      await R2Service.deleteClip(id, { passcode: state.passcode });
    }
  } catch (err) {
    console.error("Remote delete error:", err);
    if (card) card.classList.remove("removing");
    if (err.status === 401) {
      lockUploader("");
      promptUnlockFocus("Passcode rejected. Please unlock again.");
      return;
    }
    showToast(err.message || "Could not delete clip from R2.", "error");
    return;
  }

  state.clips = state.clips.filter((c) => c.id !== id);

  if (state.activeViewerClipId === id) {
    showViewerExpired(
      "This clip has expired",
      "The clip has been deleted and access is revoked."
    );
  }

  setTimeout(() => renderClipList(), card ? 220 : 0);
  refreshStorageUsage();
  if (notify) showToast("Clip permanently deleted from R2.", "success");
}

function startCountdownTicker() {
  if (state.tickerId) clearInterval(state.tickerId);

  state.tickerId = setInterval(() => {
    const now = Date.now();

    if (state.isUnlocked) {
      for (const clip of [...state.clips]) {
        const remaining = clip.expiresAt - now;
        if (remaining <= 0) {
          deleteClipById(clip.id, false);
          showToast(`"${clip.name}" expired and was removed.`);
          continue;
        }

        const pill = dom.clipList.querySelector(`[data-countdown-for="${CSS.escape(clip.id)}"]`);
        if (pill) {
          const textNode = pill.querySelector(".countdown-text");
          if (textNode) textNode.textContent = formatCountdown(remaining);
          pill.className = `thumb-countdown ${getUrgencyClass(remaining)}`.trim();
        }
      }
    }

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
  // Passcode Lock Bar events
  dom.passcodeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await verifyAndUnlock(dom.passcodeInput.value);
  });

  dom.passcodeInput.addEventListener("input", () => {
    if (!dom.authError.classList.contains("hidden")) clearAuthError();
  });

  dom.lockBtn.addEventListener("click", () => {
    lockUploader("Uploader locked.");
  });

  // Manual Refresh syncs storage usage, clips, & watched statuses
  dom.refreshStorageBtn.addEventListener("click", () => {
    syncDashboardFromR2({ showSpinner: true });
  });

  // Auto-sync watched badges when returning to the dashboard tab
  document.addEventListener("visibilitychange", () => {
    if (
      !document.hidden &&
      state.isUnlocked &&
      !state.activeViewerClipId &&
      Date.now() - state.lastSyncAt > TAB_SYNC_COOLDOWN_MS
    ) {
      syncDashboardFromR2();
    }
  });

  // Drop Zone events
  const openFilePickerIfUnlocked = () => {
    if (!state.isUnlocked) {
      promptUnlockFocus("Enter your upload passcode to unlock uploads.");
      return;
    }
    dom.fileInput.click();
  };

  dom.dropZone.addEventListener("click", openFilePickerIfUnlocked);

  dom.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFilePickerIfUnlocked();
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
      if (state.isUnlocked) {
        dom.dropZone.classList.add("drag-active");
      }
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
    if (!state.isUnlocked) {
      promptUnlockFocus("Unlock the uploader above before dropping files.");
      return;
    }
    handleFilesSelected(e.dataTransfer?.files);
  });

  // Batch Actions
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
    if (!state.isUnlocked || !state.passcode) return;
    const toDelete = [...state.clips];
    await Promise.allSettled(
      toDelete.map((clip) =>
        R2Service.deleteClip(clip.id, { passcode: state.passcode })
      )
    );
    state.clips = [];
    renderClipList();
    refreshStorageUsage();
    showToast("All clips permanently deleted from R2.", "success");
  });

  // Viewer Navigation & Copy
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
  try {
    localStorage.removeItem(LEGACY_LOCAL_LIST_KEY);
  } catch {
    // Ignore storage restrictions
  }

  dom.retentionLabel.textContent = formatRetentionHeader(EXPIRATION_MINUTES);
  setUploaderUnlocked(false);
  bindEvents();

  await handleRouteChange();
  startCountdownTicker();

  const savedCode = getStoredPasscode();
  if (savedCode && isApiConfigured()) {
    await verifyAndUnlock(savedCode, { silent: true });
  }
}

document.addEventListener("DOMContentLoaded", init);