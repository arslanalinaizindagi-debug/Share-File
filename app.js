const textArea = document.getElementById("sharedText");
const statusEl = document.getElementById("status");
const roomInput = document.getElementById("roomInput");
const titleInput = document.getElementById("titleInput");
const linkInput = document.getElementById("linkInput");
const categoryInput = document.getElementById("categoryInput");
const priorityInput = document.getElementById("priorityInput");
const dueDateInput = document.getElementById("dueDateInput");
const tagsInput = document.getElementById("tagsInput");
const noteInput = document.getElementById("noteInput");
const codeInput = document.getElementById("codeInput");
const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const uploadProgressBar = document.getElementById("uploadProgressBar");
const uploadProgressText = document.getElementById("uploadProgressText");
const fileTransferStatusEl = document.getElementById("fileTransferStatus");
const attachmentList = document.getElementById("attachmentList");
const roomErrorEl = document.getElementById("roomError");
const uploadErrorEl = document.getElementById("uploadError");
const recentRoomsListEl = document.getElementById("recentRoomsList");
const joinBtn = document.getElementById("joinBtn");
const generateBtn = document.getElementById("generateBtn");
const copyRoomBtn = document.getElementById("copyRoomBtn");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");
const sendUpdateBtn = document.getElementById("sendUpdateBtn");
const roomNameInput = document.getElementById("roomNameInput");
const saveRoomNameBtn = document.getElementById("saveRoomNameBtn");
const statsEl = document.getElementById("stats");
const roomInfoEl = document.getElementById("roomInfo");
const lastUpdateEl = document.getElementById("lastUpdate");
const memberListEl = document.getElementById("memberList");
const currentRoomBadgeEl = document.getElementById("currentRoomBadge");
const currentRoomNameBadgeEl = document.getElementById("currentRoomNameBadge");
const memberSummaryEl = document.getElementById("memberSummary");
const matchHintEl = document.getElementById("matchHint");

const API_ENDPOINT = "api.php";
const CLIENT_ID_KEY = "sync_client_id_v1";
const RECENT_ROOMS_KEY = "sync_recent_joined_rooms_v1";
const ROOM_CACHE_KEY = "sync_room_cache_v1";
const LAST_ROOM_KEY = "sync_last_room_v1";
const ROOM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const ROOM_NAME_MAX_LENGTH = 60;
const POLL_INTERVAL_MS = 2000;

let applyingRemoteUpdate = false;
let currentRoom = "";
let onlineCount = 0;
let sharedAttachments = [];
let members = [];
let attachmentObjectUrls = [];
let recentJoinedRooms = [];
let roomCache = {};
let statusResetTimer = null;
let currentRoomName = "";
let connectionReady = false;
let pollTimer = null;
let pollInFlight = false;
let reconnectTimer = null;
let hasPendingChanges = false;
let pendingAutoJoinRoom = "";

function setStatus(message, type = "info", autoResetMs = 0) {
  statusEl.textContent = message || "";
  statusEl.classList.remove("connected", "status-error", "status-info");

  if (type === "success") {
    statusEl.classList.add("connected");
  } else if (type === "error") {
    statusEl.classList.add("status-error");
  } else {
    statusEl.classList.add("status-info");
  }

  if (statusResetTimer) {
    clearTimeout(statusResetTimer);
    statusResetTimer = null;
  }

  if (autoResetMs > 0) {
    statusResetTimer = setTimeout(() => {
      if (isConnected()) {
        setStatus("Connected", "success");
      }
    }, autoResetMs);
  }
}

function isConnected() {
  return connectionReady;
}

function updateActionAvailability() {
  const normalizedInput = normalizeRoom(roomInput.value);
  const hasRoomInput = Boolean(currentRoom || normalizedInput);
  const connected = isConnected();

  joinBtn.disabled = !connected || !normalizedInput;
  generateBtn.disabled = !connected;
  copyRoomBtn.disabled = !hasRoomInput;
  copyBtn.disabled = !hasRoomInput;
  clearBtn.disabled = !hasRoomInput;
  saveRoomNameBtn.disabled = !connected || !currentRoom;
  if (sendUpdateBtn) {
    sendUpdateBtn.disabled = !connected || !currentRoom || !hasPendingChanges;
  }
}

function markPendingChanges(message = "Changes ready. Send dabao.") {
  if (applyingRemoteUpdate) {
    return;
  }

  const wasPending = hasPendingChanges;
  hasPendingChanges = true;

  const cacheRoom = currentRoom || normalizeRoom(roomInput.value);
  if (cacheRoom) {
    cacheRoomShared(cacheRoom, getSharedPayload(true));
  }

  if (!wasPending && message) {
    setStatus(message, "info", 1800);
  }

  updateActionAvailability();
}

function clearPendingChanges() {
  hasPendingChanges = false;
  updateActionAvailability();
}

function showRoomError(message) {
  roomErrorEl.textContent = message || "";
}

function showUploadError(message) {
  uploadErrorEl.textContent = message || "";
}

function setTransferStatus(message) {
  if (!fileTransferStatusEl) {
    return;
  }

  fileTransferStatusEl.textContent = message || "File transfer status: idle";
}

function safeParseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function apiRequest(action, payload = {}, method = "POST") {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
  };

  if (method !== "GET") {
    options.body = JSON.stringify(payload);
  }

  try {
    const response = await fetch(`${API_ENDPOINT}?action=${encodeURIComponent(action)}`, options);
    const data = safeParseMessage(await response.text());

    if (!response.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `Request failed: ${action}`);
    }

    connectionReady = true;
    updateActionAvailability();
    return data;
  } catch (error) {
    connectionReady = false;
    updateActionAvailability();
    scheduleReconnect(1600);
    throw error;
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function applyRoomState(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  currentRoom = normalizeRoom(message.room || currentRoom);
  roomInput.value = currentRoom;
  currentRoomName = normalizeRoomName(currentRoom, message.roomName || currentRoomName || "");
  roomNameInput.value = currentRoomName;
  cacheRoomName(currentRoom, currentRoomName);
  onlineCount = Number(message.online) || 0;
  members = Array.isArray(message.members) ? message.members : [];

  if (message.shared && typeof message.shared === "object" && !hasPendingChanges) {
    setSharedFromMessage(message.shared, true, "remote");
  }

  touchRoomActivity(currentRoom);
  saveLastRoom(currentRoom);
  setLastUpdate(message.lastUpdatedAt, message.lastUpdatedBy);
  renderRoomInfo();
  renderMembers();
}

async function pollCurrentRoom() {
  if (!currentRoom || pollInFlight) {
    return;
  }

  pollInFlight = true;

  try {
    const payload = await apiRequest("poll", { room: currentRoom, clientId });
    applyRoomState(payload);
  } catch (error) {
    setStatus("Sync issue. Retrying...", "error", 2200);
    scheduleReconnect();
  } finally {
    pollInFlight = false;
  }
}

function scheduleReconnect(delayMs = 1600) {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    try {
      await apiRequest("ping", {}, "GET");

      if (currentRoom) {
        const payload = await apiRequest("join", { room: currentRoom, clientId });
        applyRoomState(payload);
        startPolling();
        setStatus("Reconnected", "success", 1800);
      } else {
        setStatus("Connected", "success", 1500);
      }
    } catch (error) {
      setStatus("Sync issue. Retrying...", "error", 2200);
      scheduleReconnect(2500);
    }
  }, delayMs);
}

function startPolling() {
  stopPolling();

  if (!currentRoom) {
    return;
  }

  pollTimer = setInterval(() => {
    void pollCurrentRoom();
  }, POLL_INTERVAL_MS);
}

function loadRoomCache() {
  try {
    const raw = localStorage.getItem(ROOM_CACHE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch (error) {
    return {};
  }
}

function saveRoomCache() {
  try {
    localStorage.setItem(ROOM_CACHE_KEY, JSON.stringify(roomCache));
  } catch (error) {
    // Ignore browser storage errors.
  }
}

function pruneExpiredRoomCache() {
  const now = Date.now();
  let changed = false;

  Object.keys(roomCache).forEach((roomCode) => {
    const entry = roomCache[roomCode];
    const lastActivityAt = Number(entry && entry.lastActivityAt);

    if (!lastActivityAt || now - lastActivityAt > ROOM_CACHE_TTL_MS) {
      delete roomCache[roomCode];
      changed = true;
    }
  });

  if (changed) {
    saveRoomCache();
  }
}

function touchRoomActivity(roomCode) {
  const normalized = normalizeRoom(roomCode);
  if (!normalized) {
    return;
  }

  const existing = roomCache[normalized] || {};
  roomCache[normalized] = {
    ...existing,
    lastActivityAt: Date.now(),
  };
  saveRoomCache();
}

function saveLastRoom(roomCode) {
  const normalized = normalizeRoom(roomCode);

  try {
    if (!normalized) {
      localStorage.removeItem(LAST_ROOM_KEY);
      return;
    }
    localStorage.setItem(LAST_ROOM_KEY, normalized);
  } catch (error) {
    // Ignore browser storage errors.
  }
}

function getLastRoom() {
  try {
    return normalizeRoom(localStorage.getItem(LAST_ROOM_KEY) || "");
  } catch (error) {
    return "";
  }
}

function cacheRoomShared(roomCode, shared) {
  const normalized = normalizeRoom(roomCode);
  if (!normalized || !shared || typeof shared !== "object") {
    return;
  }

  roomCache[normalized] = {
    shared,
    lastActivityAt: Date.now(),
  };
  saveRoomCache();
}

function normalizeRoomName(roomCode, value) {
  const fallback = `Room ${roomCode}`;
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROOM_NAME_MAX_LENGTH);

  return normalized || fallback;
}

function cacheRoomName(roomCode, roomName) {
  const normalizedRoom = normalizeRoom(roomCode);
  if (!normalizedRoom) {
    return;
  }

  const existing = roomCache[normalizedRoom] || {};
  roomCache[normalizedRoom] = {
    ...existing,
    roomName: normalizeRoomName(normalizedRoom, roomName),
    lastActivityAt: Date.now(),
  };
  saveRoomCache();
}

function getCachedRoomName(roomCode) {
  const normalizedRoom = normalizeRoom(roomCode);
  if (!normalizedRoom) {
    return "";
  }

  const entry = roomCache[normalizedRoom];
  if (!entry || typeof entry.roomName !== "string") {
    return "";
  }

  return normalizeRoomName(normalizedRoom, entry.roomName);
}

function getCachedRoomShared(roomCode) {
  const normalized = normalizeRoom(roomCode);
  if (!normalized) {
    return null;
  }

  const entry = roomCache[normalized];
  if (!entry || !entry.shared || typeof entry.shared !== "object") {
    return null;
  }

  return entry.shared;
}

function removeRoomCache(roomCode) {
  const normalized = normalizeRoom(roomCode);
  if (!normalized || !roomCache[normalized]) {
    return;
  }

  delete roomCache[normalized];
  saveRoomCache();
}

function getOrCreateClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }

  const newId = `client_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  localStorage.setItem(CLIENT_ID_KEY, newId);
  return newId;
}

const clientId = getOrCreateClientId();

function normalizeRoom(value) {
  return (value || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function clearAttachmentObjectUrls() {
  attachmentObjectUrls.forEach((url) => {
    URL.revokeObjectURL(url);
  });
  attachmentObjectUrls = [];
}

function getObjectUrlFromDataUrl(item) {
  if (!item || typeof item.dataUrl !== "string") {
    return null;
  }

  const commaIndex = item.dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }

  const base64 = item.dataUrl.slice(commaIndex + 1);
  if (!base64) {
    return null;
  }

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const blob = new Blob([bytes], { type: item.mimeType || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    attachmentObjectUrls.push(objectUrl);
    return objectUrl;
  } catch (error) {
    return null;
  }
}

function loadRecentRooms() {
  try {
    const raw = localStorage.getItem(RECENT_ROOMS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((room) => typeof room === "string" && room.trim()).slice(0, 8);
  } catch (error) {
    return [];
  }
}

function saveRecentRooms() {
  try {
    localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(recentJoinedRooms));
  } catch (error) {
    // Ignore browser storage errors.
  }
}

function renderRecentRooms() {
  recentRoomsListEl.innerHTML = "";

  if (!recentJoinedRooms.length) {
    const empty = document.createElement("span");
    empty.className = "upload-progress-text";
    empty.textContent = "No joined rooms yet";
    recentRoomsListEl.appendChild(empty);
    return;
  }

  recentJoinedRooms.forEach((roomCode) => {
    const item = document.createElement("div");
    item.className = "recent-room-item";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-room-btn";
    btn.textContent = roomCode;
    btn.addEventListener("click", () => {
      roomInput.value = roomCode;
      joinCurrentRoom("manual");
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "recent-room-remove";
    removeBtn.textContent = "x";
    removeBtn.title = "Remove from list";
    removeBtn.addEventListener("click", () => {
      removeRecentRoom(roomCode);
    });

    item.append(btn, removeBtn);
    recentRoomsListEl.appendChild(item);
  });
}

function addRecentRoom(roomCode) {
  const normalized = normalizeRoom(roomCode);
  if (!normalized) {
    return;
  }

  recentJoinedRooms = [normalized, ...recentJoinedRooms.filter((room) => room !== normalized)].slice(0, 8);
  saveRecentRooms();
  renderRecentRooms();
}

function removeRecentRoom(roomCode) {
  recentJoinedRooms = recentJoinedRooms.filter((room) => room !== roomCode);
  saveRecentRooms();
  renderRecentRooms();
}

function getSharedPayload(includeAttachments = false) {
  const payload = {
    title: titleInput.value,
    link: linkInput.value,
    category: categoryInput.value,
    priority: priorityInput.value,
    dueDate: dueDateInput.value,
    tags: tagsInput.value,
    note: noteInput.value,
    text: textArea.value,
    code: codeInput.value,
  };

  if (includeAttachments) {
    payload.attachments = sharedAttachments;
  }

  return payload;
}

function renderAttachmentList() {
  clearAttachmentObjectUrls();
  attachmentList.innerHTML = "";

  if (sharedAttachments.length === 0) {
    const empty = document.createElement("p");
    empty.className = "attachment-empty";
    empty.textContent = "No shared files yet";
    attachmentList.appendChild(empty);
    return;
  }

  sharedAttachments.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "attachment-item";

    const info = document.createElement("div");
    info.className = "attachment-info";
    info.textContent = `${item.name} (${formatBytes(item.size)})`;

    const ownerBadge = document.createElement("span");
    ownerBadge.className = "attachment-owner";
    if (item.ownerId === clientId) {
      ownerBadge.textContent = item.pending ? "Ready to send" : "Sent by you";
    } else {
      ownerBadge.textContent = "Received";
    }
    info.appendChild(ownerBadge);

    const actions = document.createElement("div");
    actions.className = "attachment-actions";

    const fileUrl = getObjectUrlFromDataUrl(item) || item.dataUrl;

    const openLink = document.createElement("a");
    openLink.href = fileUrl;
    openLink.target = "_blank";
    openLink.rel = "noreferrer";
    openLink.textContent = "View";

    const downloadLink = document.createElement("a");
    downloadLink.href = fileUrl;
    downloadLink.download = item.name || "shared-file";
    downloadLink.textContent = "Download";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-mini btn-danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      if (item.ownerId !== clientId) {
        setStatus("Sirf uploader hi delete kar sakta hai", "error", 2200);
        return;
      }

      if (item.pending) {
        sharedAttachments = sharedAttachments.filter((_, i) => i !== index);
        renderAttachmentList();
        updateStats();
        markPendingChanges("Pending file removed. Send dabao.");
        return;
      }

      const removed = await sendAttachmentRemove(item.id);
      if (!removed) {
        return;
      }

      sharedAttachments = sharedAttachments.filter((_, i) => i !== index);
      renderAttachmentList();
      setStatus("File removed", "success", 2000);
    });

    if (item.ownerId === clientId) {
      actions.append(openLink, downloadLink, removeBtn);
    } else {
      actions.append(openLink, downloadLink);
    }
    row.append(info, actions);

    if (item.mimeType && item.mimeType.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = item.dataUrl;
      img.alt = item.name;
      img.className = "attachment-preview";
      row.appendChild(img);
    }

    if (item.mimeType && item.mimeType.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = item.dataUrl;
      video.controls = true;
      video.className = "attachment-preview";
      row.appendChild(video);
    }

    attachmentList.appendChild(row);
  });
}

function setSharedFromMessage(shared, persist = true, source = "remote") {
  const previousAttachmentIds = new Set(sharedAttachments.map((item) => item.id));
  const incomingAttachments = Array.isArray(shared.attachments) ? shared.attachments.slice(0, MAX_ATTACHMENTS) : [];

  applyingRemoteUpdate = true;
  titleInput.value = typeof shared.title === "string" ? shared.title : "";
  linkInput.value = typeof shared.link === "string" ? shared.link : "";
  categoryInput.value = typeof shared.category === "string" ? shared.category : "general";
  priorityInput.value = typeof shared.priority === "string" ? shared.priority : "normal";
  dueDateInput.value = typeof shared.dueDate === "string" ? shared.dueDate : "";
  tagsInput.value = typeof shared.tags === "string" ? shared.tags : "";
  noteInput.value = typeof shared.note === "string" ? shared.note : "";
  textArea.value = typeof shared.text === "string" ? shared.text : "";
  codeInput.value = typeof shared.code === "string" ? shared.code : "";
  sharedAttachments = incomingAttachments.map((item) => ({ ...item, pending: false }));
  applyingRemoteUpdate = false;
  clearPendingChanges();

  renderAttachmentList();
  updateStats();

  if (persist && currentRoom) {
    cacheRoomShared(currentRoom, getSharedPayload(true));
  }

  if (source === "remote") {
    const newFromOthers = incomingAttachments.filter(
      (item) => !previousAttachmentIds.has(item.id) && item.ownerId && item.ownerId !== clientId
    );
    const deliveredMine = incomingAttachments.filter(
      (item) => !previousAttachmentIds.has(item.id) && item.ownerId === clientId
    );

    if (newFromOthers.length > 0) {
      const count = newFromOthers.length;
      setTransferStatus(`File transfer status: received ${count} file(s)`);
      setStatus(`Received ${count} new file(s)`, "info", 2500);
    } else if (deliveredMine.length > 0) {
      setTransferStatus("File transfer status: upload delivered to room");
    }
  }
}

function updateStats() {
  const allText = [
    titleInput.value,
    linkInput.value,
    categoryInput.value,
    priorityInput.value,
    dueDateInput.value,
    tagsInput.value,
    noteInput.value,
    textArea.value,
    codeInput.value,
  ].join("\n");

  const attachmentBytes = sharedAttachments.reduce((acc, item) => acc + (item.size || 0), 0);
  const characters = allText.length;
  const words = allText.trim() ? allText.trim().split(/\s+/).length : 0;
  const lines = allText.length ? allText.split(/\r?\n/).length : 1;

  statsEl.textContent = `Characters: ${characters} | Words: ${words} | Lines: ${lines} | Files: ${sharedAttachments.length} (${formatBytes(attachmentBytes)})`;
}

function renderRoomInfo() {
  const visibleOnline = currentRoom && connectionReady ? Math.max(onlineCount, members.length, 1) : onlineCount;
  roomInfoEl.textContent = `Room: ${currentRoom || "-"} | Online: ${visibleOnline}`;

  if (currentRoomBadgeEl) {
    const selectedRoom = normalizeRoom(roomInput.value);
    currentRoomBadgeEl.textContent = currentRoom || (selectedRoom ? `${selectedRoom} (not joined)` : "-");
  }

  if (currentRoomNameBadgeEl) {
    const selectedRoom = normalizeRoom(roomInput.value);
    const visibleRoom = currentRoom || selectedRoom;
    if (!visibleRoom) {
      currentRoomNameBadgeEl.textContent = "-";
    } else {
      const name = currentRoomName || getCachedRoomName(visibleRoom) || normalizeRoomName(visibleRoom, "");
      currentRoomNameBadgeEl.textContent = name;
    }
  }

  if (memberSummaryEl) {
    if (!currentRoom) {
      memberSummaryEl.textContent = "Members in this room: join required";
    } else {
      memberSummaryEl.textContent = `Members in this room: ${members.length}`;
    }
  }

  updateActionAvailability();
}

function renderMembers() {
  memberListEl.innerHTML = "";

  if (!members.length) {
    const li = document.createElement("li");
    li.textContent = "No members";
    memberListEl.appendChild(li);

    if (memberSummaryEl && currentRoom) {
      memberSummaryEl.textContent = "Members in this room: only you";
    }
    return;
  }

  members.forEach((member) => {
    const li = document.createElement("li");
    const isCurrentUser = member && member.id === clientId;
    const name = member.label || member.id || "Member";
    li.textContent = isCurrentUser ? `${name} (You)` : name;
    memberListEl.appendChild(li);
  });

  if (memberSummaryEl) {
    memberSummaryEl.textContent = `Members in this room: ${members.length}`;
  }
}

function setLastUpdate(timestamp, editorName) {
  if (!timestamp) {
    lastUpdateEl.textContent = "Last update: -";
    return;
  }

  const time = new Date(timestamp).toLocaleTimeString();
  lastUpdateEl.textContent = `Last update: ${time} by ${editorName || "Unknown"}`;
}

async function joinCurrentRoom(source = "manual") {
  const targetRoom = normalizeRoom(roomInput.value);
  roomInput.value = targetRoom;

  if (!targetRoom) {
    showRoomError("Generate ya enter valid match number first");
    setStatus("Enter a valid room number", "error", 2200);
    return;
  }

  if (currentRoom && currentRoom === targetRoom && source === "manual") {
    setStatus(`Already in room: ${targetRoom}`, "info", 1800);
    return;
  }

  clearPendingChanges();

  currentRoom = targetRoom;
  showRoomError("");

  const cachedShared = getCachedRoomShared(currentRoom);
  const cachedRoomName = getCachedRoomName(currentRoom);
  currentRoomName = cachedRoomName || normalizeRoomName(currentRoom, "");
  roomNameInput.value = currentRoomName;

  if (cachedShared) {
    setSharedFromMessage(cachedShared, false, "local");
  } else {
    // If no cache exists for selected room, show empty state until server sync arrives.
    setSharedFromMessage(
      {
        title: "",
        link: "",
        category: "general",
        priority: "normal",
        dueDate: "",
        tags: "",
        note: "",
        text: "",
        code: "",
        attachments: [],
      },
      false,
      "local"
    );
  }

  touchRoomActivity(currentRoom);
  saveLastRoom(currentRoom);
  setLastUpdate(null);
  members = [];
  renderMembers();

  let response;

  try {
    response = await apiRequest("join", { room: currentRoom, clientId });
  } catch (error) {
    if (source === "auto") {
      pendingAutoJoinRoom = targetRoom;
    }
    currentRoom = "";
    onlineCount = 0;
    members = [];
    renderRoomInfo();
    renderMembers();
    showRoomError("Failed to join room");
    setStatus("Failed to join room", "error", 2200);
    return;
  }

  addRecentRoom(currentRoom);
  applyRoomState(response);
  startPolling();
  setStatus(`Joined room: ${currentRoom}`, "success", 2200);
  renderRoomInfo();
  updateActionAvailability();
}

async function requestUniqueRoom() {
  if (!connectionReady) {
    setStatus("Connection not ready. Please wait.", "error", 2200);
  }

  showRoomError("");
  setStatus("Generating room number...", "info");

  try {
    const response = await apiRequest("generate_match", { clientId });
    const generatedRoom = normalizeRoom(response.room || "");
    roomInput.value = generatedRoom;
    currentRoomName = normalizeRoomName(generatedRoom, response.roomName || "");
    roomNameInput.value = currentRoomName;
    cacheRoomName(generatedRoom, currentRoomName);
    matchHintEl.textContent = `Your unique match number: ${generatedRoom}. Join press karke is room me enter karo.`;
    setStatus(`Room generated: ${generatedRoom}. Ab Join press karein.`, "success", 2500);
    updateActionAvailability();
  } catch (error) {
    setStatus("Failed to generate room", "error", 2200);
  }
}

async function sendSharedUpdate(includeAttachments = false) {
  updateStats();

  const cacheRoom = currentRoom || normalizeRoom(roomInput.value);
  if (cacheRoom) {
    cacheRoomShared(cacheRoom, getSharedPayload(true));
  }

  if (applyingRemoteUpdate || !currentRoom) {
    return false;
  }

  try {
    const payload = await apiRequest("update", {
      room: currentRoom,
      clientId,
      shared: getSharedPayload(includeAttachments),
    });

    if (payload && typeof payload === "object") {
      applyRoomState(payload);
    }

    sharedAttachments = sharedAttachments.map((item) => ({ ...item, pending: false }));
    clearPendingChanges();
    setStatus("Changes sent", "success", 2000);
    setTransferStatus("File transfer status: sent");
    return true;
  } catch (error) {
    setStatus("Failed to save latest changes", "error", 2200);
    return false;
  }
}

async function sendAttachmentAdd(attachment) {
  if (!currentRoom) {
    setStatus("Join room first, then upload files", "error", 2400);
    return false;
  }

  try {
    const response = await apiRequest("attachment_add", {
      room: currentRoom,
      clientId,
      attachment,
    });
    applyRoomState(response);
    return true;
  } catch (error) {
    setStatus("Failed to upload file", "error", 2200);
    return false;
  }
}

async function sendAttachmentRemove(attachmentId) {
  if (!currentRoom) {
    setStatus("Cannot remove file while disconnected", "error", 2200);
    return false;
  }

  try {
    const response = await apiRequest("attachment_remove", {
      room: currentRoom,
      clientId,
      attachmentId,
    });
    applyRoomState(response);
    return true;
  } catch (error) {
    setStatus("Failed to remove file", "error", 2200);
    return false;
  }
}

async function sendRoomNameUpdate() {
  if (!currentRoom) {
    setStatus("Join room first to set room name", "error", 2200);
    return;
  }

  const nextName = normalizeRoomName(currentRoom, roomNameInput.value);
  roomNameInput.value = nextName;
  currentRoomName = nextName;
  cacheRoomName(currentRoom, nextName);
  renderRoomInfo();

  try {
    const response = await apiRequest("room_name_update", {
      room: currentRoom,
      clientId,
      roomName: nextName,
    });
    applyRoomState(response);
    setStatus(`Room name saved: ${nextName}`, "success", 2200);
  } catch (error) {
    setStatus("Failed to save room name", "error", 2200);
  }
}

async function connect() {
  try {
    await apiRequest("ping", {}, "GET");
    connectionReady = true;
    setStatus("Connected", "success");
    updateActionAvailability();
    matchHintEl.textContent = "Generate number, phir Join press karke room enter karo.";

    if (pendingAutoJoinRoom && !currentRoom) {
      roomInput.value = pendingAutoJoinRoom;
      const roomToJoin = pendingAutoJoinRoom;
      await joinCurrentRoom("auto");
      if (currentRoom === roomToJoin) {
        pendingAutoJoinRoom = "";
        setStatus(`Auto joined room: ${roomToJoin}`, "success", 2200);
      } else {
        scheduleReconnect(1800);
      }
    } else if (currentRoom) {
      startPolling();
    }
  } catch (error) {
    connectionReady = false;
    setStatus("PHP server unavailable. Retrying...", "error");
    updateActionAvailability();
    scheduleReconnect(1500);
  }
}

async function clearAllShared() {
  const selectedRoom = currentRoom || normalizeRoom(roomInput.value);

  if (!selectedRoom) {
    showRoomError("Enter or join a room first");
    setStatus("No room selected to clear", "error", 2200);
    return;
  }

  const ok = window.confirm("Clear All se room ka shared data empty ho jayega. Continue?");
  if (!ok) {
    return;
  }

  titleInput.value = "";
  linkInput.value = "";
  categoryInput.value = "general";
  priorityInput.value = "normal";
  dueDateInput.value = "";
  tagsInput.value = "";
  noteInput.value = "";
  textArea.value = "";
  codeInput.value = "";
  sharedAttachments = [];
  setTransferStatus("File transfer status: idle");
  removeRoomCache(selectedRoom);
  renderAttachmentList();

  if (currentRoom) {
    const sent = await sendSharedUpdate(true);
    if (sent) {
      setStatus("Room content cleared", "success", 2200);
    }
  } else {
    updateStats();
    setStatus("Local cached room data cleared", "success", 2200);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      uploadProgressBar.style.width = `${percent}%`;
      uploadProgressText.textContent = `Uploading ${file.name}: ${percent}%`;
    };

    reader.onload = () => {
      uploadProgressBar.style.width = "100%";
      uploadProgressText.textContent = `Uploaded ${file.name}`;
      resolve({
        id: `att_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        dataUrl: String(reader.result || ""),
        ownerId: clientId,
      });
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function processFiles(fileList) {
  const files = Array.from(fileList || []);
  showUploadError("");

  if (!currentRoom) {
    showUploadError("Join room first to upload files");
    setStatus("Join room first, then upload files", "error", 2200);
    setTransferStatus("File transfer status: failed (room not joined)");
    return;
  }

  let uploadedCount = 0;
  let failedCount = 0;

  for (const file of files) {
    if (sharedAttachments.length >= MAX_ATTACHMENTS) {
      showUploadError(`Only ${MAX_ATTACHMENTS} files allowed`);
      failedCount += 1;
      break;
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      showUploadError(`${file.name} too large (max 30MB)`);
      failedCount += 1;
      continue;
    }

    uploadProgressBar.style.width = "0%";
    uploadProgressText.textContent = `Preparing ${file.name}...`;
    setTransferStatus(`File transfer status: sending ${file.name}...`);

    try {
      const attachment = await readFileAsDataUrl(file);
      sharedAttachments.push({ ...attachment, pending: true });
      uploadedCount += 1;
    } catch (error) {
      showUploadError(`Failed to add ${file.name}`);
      failedCount += 1;
    }
  }

  renderAttachmentList();
  updateStats();

  if (uploadedCount > 0 && failedCount === 0) {
    setTransferStatus(`File transfer status: ready to send ${uploadedCount} file(s)`);
    markPendingChanges(`${uploadedCount} file(s) ready. Send dabao.`);
  } else if (uploadedCount > 0 && failedCount > 0) {
    setTransferStatus(`File transfer status: ${uploadedCount} ready, ${failedCount} failed`);
    markPendingChanges(`${uploadedCount} file(s) ready, ${failedCount} failed. Send dabao.`);
  } else if (failedCount > 0) {
    setStatus("File upload failed. Please try again.", "error", 2500);
    setTransferStatus("File transfer status: failed");
  }

  if (files.length === 0) {
    uploadProgressBar.style.width = "0%";
    uploadProgressText.textContent = "No upload in progress";
  }
}

joinBtn.addEventListener("click", () => {
  void joinCurrentRoom("manual");
});
generateBtn.addEventListener("click", () => {
  void requestUniqueRoom();
});
copyRoomBtn.addEventListener("click", async () => {
  const roomCode = currentRoom || normalizeRoom(roomInput.value);
  if (!roomCode) {
    showRoomError("No room number to copy");
    setStatus("No room number to copy", "error", 2200);
    return;
  }

  try {
    await navigator.clipboard.writeText(roomCode);
    setStatus(`Room number copied: ${roomCode}`, "success", 2200);
    showRoomError("");
  } catch (error) {
    setStatus("Clipboard blocked by browser", "error", 2500);
  }
});

roomInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void joinCurrentRoom("manual");
  }
});

roomInput.addEventListener("input", () => {
  const normalized = normalizeRoom(roomInput.value);
  if (roomInput.value !== normalized) {
    roomInput.value = normalized;
  }

  if (normalized) {
    saveLastRoom(normalized);
    const cachedRoomName = getCachedRoomName(normalized);
    roomNameInput.value = cachedRoomName || normalizeRoomName(normalized, "");
    currentRoomName = roomNameInput.value;
    const cachedShared = getCachedRoomShared(normalized);
    if (cachedShared && !currentRoom) {
      setSharedFromMessage(cachedShared, false, "local");
      setStatus("Cached room data loaded (local)", "info", 2200);
    }
  }

  updateActionAvailability();
});

saveRoomNameBtn.addEventListener("click", sendRoomNameUpdate);
roomNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void sendRoomNameUpdate();
  }
});

[titleInput, linkInput, categoryInput, priorityInput, dueDateInput, tagsInput, noteInput, textArea, codeInput].forEach((el) => {
  el.addEventListener("input", () => {
    updateStats();
    markPendingChanges("");
  });
});

if (sendUpdateBtn) {
  sendUpdateBtn.addEventListener("click", async () => {
    const sent = await sendSharedUpdate(true);
    if (sent) {
      uploadProgressText.textContent = "No upload in progress";
      uploadProgressBar.style.width = "0%";
    }
  });
}

fileInput.addEventListener("change", async () => {
  await processFiles(fileInput.files);
  fileInput.value = "";
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("active");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("active");
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("active");
  await processFiles(event.dataTransfer ? event.dataTransfer.files : []);
});

copyBtn.addEventListener("click", async () => {
  const allData = [
    `Match Number: ${currentRoom || "-"}`,
    `Title: ${titleInput.value}`,
    `Link: ${linkInput.value}`,
    `Category: ${categoryInput.value}`,
    `Priority: ${priorityInput.value}`,
    `Due Date: ${dueDateInput.value}`,
    `Tags: ${tagsInput.value}`,
    `Files: ${sharedAttachments.map((item) => item.name).join(", ")}`,
    "",
    "Note:",
    noteInput.value,
    "",
    "Text:",
    textArea.value,
    "",
    "Code:",
    codeInput.value,
  ].join("\n");

  try {
    await navigator.clipboard.writeText(allData);
    setStatus("All shared data copied", "success", 2200);
  } catch (error) {
    setStatus("Clipboard blocked by browser", "error", 2500);
  }
});

clearBtn.addEventListener("click", () => {
  void clearAllShared();
});

recentJoinedRooms = loadRecentRooms();
renderRecentRooms();

roomCache = loadRoomCache();
pruneExpiredRoomCache();

const lastRoom = getLastRoom();
if (lastRoom) {
  pendingAutoJoinRoom = lastRoom;
  roomInput.value = lastRoom;
  const cachedRoomName = getCachedRoomName(lastRoom);
  roomNameInput.value = cachedRoomName || normalizeRoomName(lastRoom, "");
  currentRoomName = roomNameInput.value;
  const cachedShared = getCachedRoomShared(lastRoom);
  if (cachedShared) {
    setSharedFromMessage(cachedShared, false, "local");
    setTransferStatus("File transfer status: restored from cache");
    setStatus("Previous room cache restored. Join press karke sync continue karein.", "info", 2600);
  }
}

updateStats();
renderRoomInfo();
renderMembers();
updateActionAvailability();
void connect();

setInterval(pruneExpiredRoomCache, 60 * 1000);

window.addEventListener("beforeunload", () => {
  clearAttachmentObjectUrls();
});
