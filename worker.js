// Cloudflare Worker module. Pair with wrangler.jsonc so the ROOMS Durable
// Object binding and its initial SQLite-class migration are configured.
const MAX_PEERS_PER_ROOM = 16;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://lanparty-vc.github.io",
]);

export default {
  async fetch(request, env) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket connection.", { status: 426 });
    }

    if (!isAllowedOrigin(request.headers.get("Origin"), env.ALLOWED_ORIGINS)) {
      return new Response("Origin is not allowed.", { status: 403 });
    }

    const url = new URL(request.url);
    const roomCode = url.searchParams.get("room");
    let roomKey;

    if (roomCode !== null) {
      if (!/^\d{6}$/.test(roomCode)) {
        return new Response("Room codes must be six digits.", { status: 400 });
      }
      roomKey = `code:${roomCode}`;
    } else {
      if (url.searchParams.get("net") !== "network-auto") {
        return new Response("A six-digit room code or automatic network room is required.", {
          status: 400,
        });
      }
      const clientIp = request.headers.get("CF-Connecting-IP");
      if (!clientIp || clientIp.length > 64) {
        return new Response("Could not determine your public network address.", {
          status: 400,
        });
      }
      roomKey = `network:${clientIp}`;
    }

    const roomId = env.ROOMS.idFromName(roomKey);
    return env.ROOMS.get(roomId).fetch(request);
  },
};

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket connection.", { status: 426 });
    }

    const openSockets = this.getOpenSockets();
    if (openSockets.length >= MAX_PEERS_PER_ROOM) {
      return new Response("This room is full.", { status: 429 });
    }

    const url = new URL(request.url);
    const peerId = crypto.randomUUID();
    const nickname = sanitizeNickname(url.searchParams.get("nick"));
    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({ peerId, nickname });
    this.ctx.acceptWebSocket(server);

    this.send(server, { type: "room-info", myId: peerId });
    this.broadcastPeers();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH) {
      this.sendError(socket, "Signaling messages must be text and under 64 KB.");
      socket.close(1009, "Message too large or binary");
      return;
    }

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      this.sendError(socket, "Invalid signaling message.");
      return;
    }

    const peer = socket.deserializeAttachment();
    if (!peer?.peerId || !msg || typeof msg !== "object") {
      this.sendError(socket, "Invalid signaling message.");
      return;
    }

    switch (msg.type) {
      case "offer":
      case "answer":
      case "ice":
        this.relay(socket, peer.peerId, msg);
        break;
      case "speaking":
        this.broadcastPeersMessage({
          type: "speaking",
          from: peer.peerId,
          speaking: Boolean(msg.speaking),
        }, socket);
        break;
      case "get-peers":
        this.sendPeerList(socket);
        break;
      default:
        this.sendError(socket, "Unknown signaling message type.");
    }
  }

  webSocketClose(socket) {
    this.removeSocket(socket);
  }

  webSocketError(socket) {
    this.removeSocket(socket);
  }

  getOpenSockets() {
    return this.ctx.getWebSockets().filter(
      (socket) => socket.readyState === WebSocket.OPEN,
    );
  }

  send(socket, message) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    } catch (error) {
      console.error("Could not send signaling message:", error);
      try {
        socket.close(1011, "Signaling send failed");
      } catch (closeError) {
        console.error("Could not close failed WebSocket:", closeError);
      }
    }
  }

  sendError(socket, message) {
    this.send(socket, { type: "error", message });
  }

  sendPeerList(socket) {
    const peers = this.getOpenSockets().map((peerSocket) => {
      const peer = peerSocket.deserializeAttachment();
      return {
        id: peer.peerId,
        nick: peer.nickname,
        self: peer.peerId,
      };
    });
    this.send(socket, { type: "peers", peers });
  }

  broadcastPeers() {
    for (const socket of this.getOpenSockets()) {
      this.sendPeerList(socket);
    }
  }

  broadcastPeersMessage(message, excludedSocket) {
    for (const socket of this.getOpenSockets()) {
      if (socket !== excludedSocket) this.send(socket, message);
    }
  }

  relay(senderSocket, fromId, message) {
    if (typeof message.to !== "string" || !message.to || message.to === fromId) {
      this.sendError(senderSocket, "A valid target peer is required.");
      return;
    }

    const recipient = this.getOpenSockets().find((socket) => {
      return socket.deserializeAttachment()?.peerId === message.to;
    });
    if (!recipient) {
      this.sendError(senderSocket, "The target peer is no longer in this room.");
      return;
    }

    this.send(recipient, { ...message, from: fromId });
  }

  removeSocket(socket) {
    this.broadcastPeers();
  }
}

function sanitizeNickname(value) {
  const nickname = (value || "Guest")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 32);
  return nickname || "Guest";
}

function isAllowedOrigin(origin, configuredOrigins = "") {
  if (!origin) return false;

  let normalizedOrigin;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  const allowedOrigins = new Set(DEFAULT_ALLOWED_ORIGINS);
  for (const configuredOrigin of configuredOrigins.split(",")) {
    const value = configuredOrigin.trim();
    if (value) allowedOrigins.add(value);
  }

  if (allowedOrigins.has(normalizedOrigin)) return true;

  try {
    const parsedOrigin = new URL(normalizedOrigin);
    return (
      parsedOrigin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsedOrigin.hostname)
    );
  } catch {
    return false;
  }
}
