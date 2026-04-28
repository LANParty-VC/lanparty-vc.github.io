const SIGNAL_URL = "wss://lanpartyvc-signal.arahomeschool23.workers.dev";

let ws;
let pc;
let localStream;
let nickname;
let isMuted = false;

const peersGridEl = document.getElementById("peers-grid");
const statusDotEl = document.getElementById("status-dot");
const statusTextEl = document.getElementById("status-text");
const roomCodePillEl = document.getElementById("room-code-pill");
const userLabelEl = document.getElementById("user-label");
const selfMeterBarEl = document.getElementById("self-meter-bar");
const logEl = document.getElementById("log");

const speakingState = new Map(); // peerId -> { cardEl, analyser, source, self }

init();

async function init() {
  const params = new URLSearchParams(location.search);
  nickname = params.get("nick") || "Guest";

  userLabelEl.textContent = `You are: ${nickname}`;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusTextEl.textContent = "Mic access denied.";
    statusDotEl.classList.add("lp-status-bad");
    log("Mic access denied.");
    return;
  }

  setupUI();
  setupWebSocket();
}

function setupUI() {
  document.getElementById("mute-btn").onclick = () => {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
    document.getElementById("mute-btn").textContent = isMuted ? "Unmute" : "Mute";
    log(isMuted ? "You muted your mic." : "You unmuted your mic.");
  };

  document.getElementById("device-btn").onclick = async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      swapLocalStream(newStream);
      log("Switched microphone.");
    } catch (err) {
      log("Failed to switch microphone.");
    }
  };

  document.getElementById("leave-btn").onclick = () => {
    cleanupAndLeave();
  };

  window.addEventListener("beforeunload", () => {
    try {
      ws?.close();
      pc?.close();
      localStream?.getTracks().forEach((t) => t.stop());
    } catch {}
  });
}

function setupWebSocket() {
  ws = new WebSocket(`${SIGNAL_URL}/?nick=${encodeURIComponent(nickname)}`);

  ws.onopen = () => {
    statusTextEl.textContent = "Connected to signaling";
    statusDotEl.classList.remove("lp-status-bad");
    statusDotEl.classList.add("lp-status-ok");
    log("Connected to signaling server.");
    createPeerConnection();
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "room-info":
        roomCodePillEl.textContent = `Room: #${msg.code}`;
        log(`Joined network room #${msg.code}.`);
        break;
      case "peers":
        updatePeers(msg.peers);
        break;
      case "offer":
        await handleOffer(msg);
        break;
      case "answer":
        await handleAnswer(msg);
        break;
      case "ice":
        await handleIce(msg);
        break;
    }
  };

  ws.onclose = () => {
    statusTextEl.textContent = "Disconnected.";
    statusDotEl.classList.remove("lp-status-ok");
    statusDotEl.classList.add("lp-status-bad");
    log("Disconnected from signaling.");
  };

  ws.onerror = () => {
    statusTextEl.textContent = "Signaling error.";
    statusDotEl.classList.add("lp-status-bad");
    log("Signaling error.");
  };
}

function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    attachRemoteStream(stream);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "ice", candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    log(`WebRTC state: ${pc.connectionState}`);
  };

  makeOffer();
}

async function makeOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", sdp: offer });
}

async function handleOffer(msg) {
  await pc.setRemoteDescription(msg.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: "answer", sdp: answer });
}

async function handleAnswer(msg) {
  await pc.setRemoteDescription(msg.sdp);
}

async function handleIce(msg) {
  if (msg.candidate) {
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (err) {
      log("Failed to add ICE candidate.");
    }
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function updatePeers(peers) {
  peersGridEl.innerHTML = "";
  speakingState.clear();

  peers.forEach((p) => {
    const card = document.createElement("div");
    card.className = "lp-peer-card";
    card.dataset.peerId = p.id;

    const nameEl = document.createElement("div");
    nameEl.className = "lp-peer-name";
    nameEl.textContent = p.nick;

    const metaEl = document.createElement("div");
    metaEl.className = "lp-peer-meta";
    metaEl.textContent = p.self === p.id ? "You" : "Connected";

    const badge = document.createElement("div");
    badge.className = "lp-peer-badge";
    badge.textContent = p.self === p.id ? "Local" : "Remote";

    card.appendChild(nameEl);
    card.appendChild(metaEl);
    card.appendChild(badge);

    peersGridEl.appendChild(card);

    speakingState.set(p.id, {
      cardEl: card,
      analyser: null,
      source: null,
      self: p.self === p.id,
    });
  });

  // attach analyser for self
  const selfPeer = [...speakingState.values()].find((s) => s.self);
  if (selfPeer && localStream) {
    attachSpeakingAnalyser(selfPeer, localStream, true);
  }
}

function attachRemoteStream(stream) {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = stream;
  document.body.appendChild(audio);

  // assume single remote peer for now
  const remotePeer = [...speakingState.values()].find((s) => !s.self);
  if (remotePeer) {
    attachSpeakingAnalyser(remotePeer, stream, false);
  }
}

function attachSpeakingAnalyser(peerState, stream, isSelf) {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  peerState.analyser = analyser;
  peerState.source = source;

  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const speaking = avg > 40; // tweak threshold

    peerState.cardEl.classList.toggle("lp-peer-speaking", speaking);

    if (isSelf) {
      const level = Math.min(100, Math.max(0, (avg / 80) * 100));
      selfMeterBarEl.style.width = `${level}%`;
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

function swapLocalStream(newStream) {
  localStream.getTracks().forEach((t) => t.stop());
  localStream = newStream;

  localStream.getTracks().forEach((track) => {
    const sender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === track.kind);
    if (sender) sender.replaceTrack(track);
  });

  const selfPeer = [...speakingState.values()].find((s) => s.self);
  if (selfPeer) {
    attachSpeakingAnalyser(selfPeer, localStream, true);
  }
}

function cleanupAndLeave() {
  try {
    ws?.close();
    pc?.close();
    localStream?.getTracks().forEach((t) => t.stop());
  } finally {
    window.location.href = "index.html";
  }
}

function log(text) {
  const line = document.createElement("div");
  line.className = "lp-log-line";
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
