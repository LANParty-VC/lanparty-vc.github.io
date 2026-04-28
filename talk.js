// talk.js — LANParty VC (WebSocket Signaling)

const joinBtn = document.getElementById("joinBtn");
const leaveBtn = document.getElementById("leaveBtn");
const muteBtn = document.getElementById("muteBtn");
const statusEl = document.getElementById("status");
const peersEl = document.getElementById("peers");
const logEl = document.getElementById("log");
const roomIdEl = document.getElementById("roomId");

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");

let peerId = crypto.randomUUID();
let ws = null;
let localStream = null;
let muted = false;
let joined = false;

const peerConnections = new Map();

function log(msg) {
  console.log(msg);
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function renderPeers() {
  peersEl.innerHTML = "";
  for (const [id] of peerConnections.entries()) {
    const div = document.createElement("div");
    div.className = "peer";

    const dot = document.createElement("div");
    dot.className = "peer-dot";

    const label = document.createElement("span");
    label.textContent = id === peerId ? "You" : id.slice(0, 6);

    div.appendChild(dot);
    div.appendChild(label);
    peersEl.appendChild(div);
  }
}

function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "candidate",
        from: peerId,
        to: remoteId,
        candidate: event.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = event.streams[0];
    document.body.appendChild(audio);
    log(`Audio from ${remoteId}`);
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      peerConnections.delete(remoteId);
      renderPeers();
    }
  };

  peerConnections.set(remoteId, pc);
  renderPeers();
  return pc;
}

async function join() {
  if (joined) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("Microphone access denied");
    return;
  }

  ws = new WebSocket(
  `wss://lanpartyvc-signal.arahomeschool23.workers.dev/?room=${roomId}&peer=${peerId}`
);

  ws.onopen = () => {
    log("Connected to signaling server");
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "peer-join") {
      const id = msg.peerId;
      if (peerId < id) {
        const pc = createPeerConnection(id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        ws.send(JSON.stringify({
          type: "offer",
          from: peerId,
          to: id,
          sdp: offer
        }));
      }
    }

    if (msg.type === "peer-leave") {
      const pc = peerConnections.get(msg.peerId);
      if (pc) pc.close();
      peerConnections.delete(msg.peerId);
      renderPeers();
    }

    if (msg.type === "offer") {
      const pc = createPeerConnection(msg.from);
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      ws.send(JSON.stringify({
        type: "answer",
        from: peerId,
        to: msg.from,
        sdp: answer
      }));
    }

    if (msg.type === "answer") {
      const pc = peerConnections.get(msg.from);
      if (pc) await pc.setRemoteDescription(msg.sdp);
    }

    if (msg.type === "candidate") {
      const pc = peerConnections.get(msg.from);
      if (pc) await pc.addIceCandidate(msg.candidate);
    }
  };

  joined = true;
  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  muteBtn.disabled = false;
  setStatus("In voice");
}

function leave() {
  if (!joined) return;

  ws.close();
  ws = null;

  for (const [id, pc] of peerConnections.entries()) {
    pc.close();
  }
  peerConnections.clear();
  renderPeers();

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  joined = false;
  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  muteBtn.disabled = true;
  setStatus("Idle");
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  muteBtn.textContent = muted ? "Unmute" : "Mute";
}

roomIdEl.textContent = "Room: " + roomId.slice(0, 12) + "…";

joinBtn.onclick = join;
leaveBtn.onclick = leave;
muteBtn.onclick = toggleMute;

setStatus("Idle");
