const SIGNAL_URL = "wss://lanpartyvc-signal.arahomeschool23.workers.dev";

let ws;
let pc;
let localStream;
let nickname;
let isMuted = false;

const roomTitleEl = document.getElementById("room-title");
const userLabelEl = document.getElementById("user-label");
const statusEl = document.getElementById("status");
const peersListEl = document.getElementById("peers-list");
const muteBtn = document.getElementById("mute-btn");
const deviceBtn = document.getElementById("device-btn");
const leaveBtn = document.getElementById("leave-btn");
const eventsEl = document.getElementById("log") || document.getElementById("events"); // whichever you used

// speaking state: peerId -> { li, analyser, source, self }
const speakingState = new Map();

init();

async function init() {
  const params = new URLSearchParams(location.search);
  nickname = params.get("nick") || "Guest";

  userLabelEl.textContent = `You are: ${nickname}`;
  roomTitleEl.textContent = `Room: null`; // will be updated by server if you want

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusEl.textContent = "Mic access denied.";
    log("Mic access denied.");
    return;
  }

  setupUI();
  setupWebSocket();
}

function setupUI() {
  muteBtn.onclick = () => {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
    muteBtn.textContent = isMuted ? "Unmute" : "Mute";
    log(isMuted ? "You muted your mic." : "You unmuted your mic.");
  };

  deviceBtn.onclick = async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      swapLocalStream(newStream);
      log("Switched microphone.");
    } catch (err) {
      log("Failed to switch microphone.");
    }
  };

  leaveBtn.onclick = () => {
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
    statusEl.textContent = "Connected to signaling";
    log("Connected to signaling server.");
    createPeerConnection();
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "room-info":
        roomTitleEl.textContent = `Room: ${msg.code}`;
        log(`Joined network room ${msg.code}.`);
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
    statusEl.textContent = "Disconnected.";
    log("Disconnected from signaling.");
  };

  ws.onerror = () => {
    statusEl.textContent = "Signaling error.";
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
  peersListEl.innerHTML = "";
  speakingState.clear();

  peers.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.nick + (p.self === p.id ? " (You)" : "");
    peersListEl.appendChild(li);

    speakingState.set(p.id, {
      li,
      analyser: null,
      source: null,
      self: p.self === p.id,
    });
  });

  // attach analyser for self
  const selfPeer = [...speakingState.values()].find((s) => s.self);
  if (selfPeer && localStream) {
    attachSpeakingAnalyser(selfPeer, localStream);
  }
}

function attachRemoteStream(stream) {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = stream;
  document.body.appendChild(audio);

  const remotePeer = [...speakingState.values()].find((s) => !s.self);
  if (remotePeer) {
    attachSpeakingAnalyser(remotePeer, stream);
  }
}

function attachSpeakingAnalyser(peerState, stream) {
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

    peerState.li.classList.toggle("lp-peer-speaking", speaking);
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
    attachSpeakingAnalyser(selfPeer, localStream);
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
  if (!eventsEl) return;
  const line = document.createElement("div");
  line.textContent = text;
  eventsEl.appendChild(line);
  eventsEl.scrollTop = eventsEl.scrollHeight;
}
