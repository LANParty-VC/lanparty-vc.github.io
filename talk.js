// talk.js — LANParty VC (WebSocket Signaling, Discord-style UI)

const joinBtn = document.getElementById("joinBtn");
const leaveBtn = document.getElementById("leaveBtn");
const muteBtn = document.getElementById("muteBtn");
const homeBtn = document.getElementById("homeBtn");
const statusEl = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const peersEl = document.getElementById("peers");
const roomIdEl = document.getElementById("roomId");

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");

let peerId = crypto.randomUUID();
let ws = null;
let localStream = null;
let muted = false;
let joined = false;

const peerConnections = new Map();

function setStatus(text, live = false) {
  statusEl.textContent = text;
  if (live) {
    statusDot.classList.add("live");
  } else {
    statusDot.classList.remove("live");
  }
}

function renderPeers() {
  peersEl.innerHTML = "";
  for (const [id] of peerConnections.entries()) {
    const pill = document.createElement("div");
    pill.className = "peer-pill";

    const avatar = document.createElement("div");
    avatar.className = "peer-avatar";
    avatar.textContent = id === peerId ? "YOU" : id.slice(0, 2).toUpperCase();

    const labelMain = document.createElement("div");
    labelMain.className = "peer-label-main";
    labelMain.textContent = id === peerId ? "You" : "Peer";

    const labelSub = document.createElement("div");
    labelSub.className = "peer-label-sub";
    labelSub.textContent = id.slice(0, 6);

    const labelWrap = document.createElement("div");
    labelWrap.style.display = "flex";
    labelWrap.style.flexDirection = "column";
    labelWrap.appendChild(labelMain);
    labelWrap.appendChild(labelSub);

    pill.appendChild(avatar);
    pill.appendChild(labelWrap);
    peersEl.appendChild(pill);
  }

  if (peerConnections.size === 0) {
    const empty = document.createElement("div");
    empty.className = "peer-pill";
    empty.textContent = "No peers yet — share this room with someone on your network.";
    peersEl.appendChild(empty);
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
    if (event.candidate && ws) {
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

  ws.onerror = () => {
    console.log("WebSocket error — cannot connect to signaling server");
    alert("Failed to connect to signaling server.");
  };

  ws.onopen = () => {
    console.log("Connected to signaling server");

    joined = true;
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    muteBtn.disabled = false;
    setStatus("In voice", true);

    // Add self to peers list
    peerConnections.set(peerId, null);
    renderPeers();
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "peer-join") {
      const id = msg.peerId;
      if (!peerConnections.has(id)) {
        peerConnections.set(id, null);
        renderPeers();
      }

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
}

function leave() {
  if (!joined) return;

  if (ws) ws.close();
  ws = null;

  for (const [, pc] of peerConnections.entries()) {
    if (pc) pc.close();
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
  muted = false;
  muteBtn.textContent = "Mute";
  setStatus("Idle", false);
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  muteBtn.textContent = muted ? "Unmute" : "Mute";
}

roomIdEl.querySelector("span").textContent = roomId
  ? roomId.slice(0, 12) + "…"
  : "Unknown";

joinBtn.onclick = join;
leaveBtn.onclick = leave;
muteBtn.onclick = toggleMute;
homeBtn.onclick = () => {
  window.location.href = "https://lanparty-vc.github.io";
};

setStatus("Idle", false);
renderPeers();
