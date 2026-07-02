const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

function createId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function normalizeRoom(roomId) {
  if (typeof roomId !== "string") {
    return "main";
  }

  const safeRoom = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
  return safeRoom || "main";
}

function generateUniqueRoomCode() {
  const maxAttempts = 200;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));

    if (!rooms.has(code)) {
      return code;
    }
  }

  return `${Date.now()}`.slice(-6);
}

function sanitizeRoomName(roomId, value) {
  const fallback = `Room ${roomId}`;

  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 60) : fallback;
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomName: sanitizeRoomName(roomId, ""),
      shared: {
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
      clients: new Set(),
      lastUpdatedAt: null,
      lastUpdatedBy: "Participant",
    });
  }

  return rooms.get(roomId);
}

function sanitizeAttachment(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const name = typeof item.name === "string" ? item.name.slice(0, 120) : "file";
  const mimeType = typeof item.mimeType === "string" ? item.mimeType.slice(0, 80) : "application/octet-stream";
  const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";

  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }

  const base64Data = dataUrl.slice(commaIndex + 1);
  if (!base64Data) {
    return null;
  }

  const approxBytes = Math.floor((base64Data.length * 3) / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    return null;
  }

  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.slice(0, 80) : createId("att"),
    name,
    mimeType,
    dataUrl,
    size: approxBytes,
    ownerId: typeof item.ownerId === "string" ? item.ownerId.slice(0, 80) : "",
  };
}

function sanitizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const result = [];

  for (const item of value) {
    if (result.length >= MAX_ATTACHMENTS) {
      break;
    }

    const safe = sanitizeAttachment(item);
    if (safe) {
      result.push(safe);
    }
  }

  return result;
}

function send(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function getRoomMembers(room) {
  const uniqueIds = [...new Set([...room.clients].map((client) => client.clientId).filter(Boolean))];

  return uniqueIds
    .slice(0, 100)
    .sort()
    .map((id) => ({
      id,
      label: `Member-${id.slice(-4)}`,
    }));
}

function broadcastPresence(roomId) {
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  const payload = {
    type: "presence",
    room: roomId,
    roomName: room.roomName,
    online: room.clients.size,
    members: getRoomMembers(room),
  };

  room.clients.forEach((client) => {
    send(client, payload);
  });
}

function broadcastSync(roomId) {
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  const payload = {
    type: "sync",
    room: roomId,
    roomName: room.roomName,
    shared: room.shared,
    online: room.clients.size,
    members: getRoomMembers(room),
    lastUpdatedAt: room.lastUpdatedAt,
    lastUpdatedBy: room.lastUpdatedBy,
  };

  room.clients.forEach((client) => {
    send(client, payload);
  });
}

function leaveRoom(socket) {
  if (!socket.roomId) {
    return;
  }

  const room = rooms.get(socket.roomId);

  if (!room) {
    socket.roomId = null;
    return;
  }

  room.clients.delete(socket);

  const oldRoomId = socket.roomId;
  socket.roomId = null;

  // Preserve room state even if everyone leaves so data remains available
  // when users join this room again later.
  broadcastPresence(oldRoomId);
}

function joinRoom(socket, targetRoomId) {
  leaveRoom(socket);

  const roomId = normalizeRoom(targetRoomId);
  const room = getOrCreateRoom(roomId);
  room.clients.add(socket);
  socket.roomId = roomId;

  send(socket, {
    type: "info",
    message: `Joined room: ${roomId}`,
  });

  broadcastSync(roomId);
}

app.use(express.static("public"));

wss.on("connection", (socket) => {
  socket.userName = "Participant";
  socket.roomId = null;
  socket.clientId = createId("client");

  socket.on("message", (rawData) => {
    let message;

    try {
      message = JSON.parse(rawData.toString());
    } catch (error) {
      return;
    }

    if (message.type === "join") {
      if (typeof message.clientId === "string" && message.clientId.trim()) {
        socket.clientId = message.clientId.slice(0, 80);
      }

      joinRoom(socket, message.room);
      return;
    }

    if (message.type === "generate_match") {
      if (typeof message.clientId === "string" && message.clientId.trim()) {
        socket.clientId = message.clientId.slice(0, 80);
      }

      const generatedRoom = generateUniqueRoomCode();

      send(socket, {
        type: "generated_room",
        room: generatedRoom,
      });
      return;
    }

    if (message.type === "attachment_add" && socket.roomId) {
      const room = getOrCreateRoom(socket.roomId);

      if (room.shared.attachments.length >= MAX_ATTACHMENTS) {
        return;
      }

      const safeAttachment = sanitizeAttachment(message.attachment);
      if (!safeAttachment) {
        return;
      }

      safeAttachment.ownerId = socket.clientId;

      room.shared.attachments.push(safeAttachment);
      room.lastUpdatedAt = Date.now();
      room.lastUpdatedBy = socket.userName;
      broadcastSync(socket.roomId);
      return;
    }

    if (message.type === "attachment_remove" && socket.roomId) {
      const room = getOrCreateRoom(socket.roomId);
      const attachmentId = typeof message.attachmentId === "string" ? message.attachmentId : "";
      const index = room.shared.attachments.findIndex((item) => item.id === attachmentId);

      if (index < 0) {
        return;
      }

      if (room.shared.attachments[index].ownerId !== socket.clientId) {
        return;
      }

      room.shared.attachments.splice(index, 1);
      room.lastUpdatedAt = Date.now();
      room.lastUpdatedBy = socket.userName;
      broadcastSync(socket.roomId);
      return;
    }

    if (message.type === "room_name_update" && socket.roomId) {
      const room = getOrCreateRoom(socket.roomId);
      room.roomName = sanitizeRoomName(socket.roomId, message.roomName);
      room.lastUpdatedAt = Date.now();
      room.lastUpdatedBy = socket.userName;
      broadcastSync(socket.roomId);
      return;
    }

    if (message.type !== "update" || !message.shared || typeof message.shared !== "object" || !socket.roomId) {
      return;
    }

    const room = getOrCreateRoom(socket.roomId);
    room.shared = {
      title: typeof message.shared.title === "string" ? message.shared.title.slice(0, 120) : room.shared.title,
      link: typeof message.shared.link === "string" ? message.shared.link.slice(0, 300) : room.shared.link,
      category: typeof message.shared.category === "string" ? message.shared.category.slice(0, 40) : room.shared.category,
      priority: typeof message.shared.priority === "string" ? message.shared.priority.slice(0, 20) : room.shared.priority,
      dueDate: typeof message.shared.dueDate === "string" ? message.shared.dueDate.slice(0, 20) : room.shared.dueDate,
      tags: typeof message.shared.tags === "string" ? message.shared.tags.slice(0, 200) : room.shared.tags,
      note: typeof message.shared.note === "string" ? message.shared.note.slice(0, 5000) : room.shared.note,
      text: typeof message.shared.text === "string" ? message.shared.text.slice(0, 60000) : room.shared.text,
      code: typeof message.shared.code === "string" ? message.shared.code.slice(0, 60000) : room.shared.code,
      attachments:
        "attachments" in message.shared ? sanitizeAttachments(message.shared.attachments) : room.shared.attachments,
    };
    room.lastUpdatedAt = Date.now();
    room.lastUpdatedBy = socket.userName;

    broadcastSync(socket.roomId);
  });

  socket.on("close", () => {
    leaveRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
