const SIGNAL_URL = "wss://lanpartyvc-signal.arahomeschool23.workers.dev";

let ws;
let peerConnections = new Map(); // peerId -> RTCPeerConnection
let remoteStreams = new Map(); // peerId -> MediaStream
let localStream;
let nickname;
let myId;
let isMuted = false;

const roomTitleEl = document.getElementById("room-title");
const userLabelEl = document.getElementById("user-label");
const statusEl = document.getElementById("status");
const peersListEl = document.getElementById("peers-list");

const muteBtn = document.getElementById("mute-btn");
const deviceBtn = document.getElementById("device-btn");
const leaveBtn = document.getElementById("leave-btn");

const speakingState = new Map(); // peerId -> { cardEl, analyser, source, self }

init();

async function init() {
  const params = new URLSearchParams(location.search);
  nickname = params.get("nick") || "Guest";

  userLabelEl.textContent = `You are: ${nickname}`;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusEl.textContent = "Mic access denied.";
    return;
  }

  setupUI();
  await setupWebSocket();
}

function setupUI() {
  muteBtn.onclick = () => {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
    muteBtn.textContent = isMuted ? "Unmute" : "Mute";
  };

  deviceBtn.onclick = async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      swapLocalStream(newStream);
    } catch {}
  };

  leaveBtn.onclick = () => cleanupAndLeave();
}

function getLocalNetworkId() {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => resolve("unknown"));

    pc.onicecandidate = (ice) => {
      if (!ice || !ice.candidate) return;
      const match = ice.candidate.candidate.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
      if (match) {
        resolve(match[1]);
        pc.close();
      }
    };

    setTimeout(() => {
      resolve("unknown");
      try {
        pc.close();
      } catch {}
    }, 2000);
  });
}

async function setupWebSocket() {
  const networkId = await getLocalNetworkId();
  ws = new WebSocket(`${SIGNAL_URL}/?nick=${encodeURIComponent(nickname)}&net=${encodeURIComponent(networkId)}`);

  ws.onopen = () => {
    statusEl.textContent = "Connected";
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "room-info":
        myId = msg.myId;
        break;

      case "peers":
        await updatePeers(msg.peers);
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
  };
}

function createPeerConnectionTo(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    remoteStreams.set(peerId, stream);
    attachRemoteStream(peerId, stream);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) send({ type: "ice", candidate: event.candidate, to: peerId });
  };

  peerConnections.set(peerId, pc);
  return pc;
}

async function makeOfferTo(peerId) {
  let pc = peerConnections.get(peerId);
  if (!pc) pc = createPeerConnectionTo(peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", sdp: offer, to: peerId });
}

async function handleOffer(msg) {
  const peerId = msg.from;
  let pc = peerConnections.get(peerId);
  if (!pc) pc = createPeerConnectionTo(peerId);

  await pc.setRemoteDescription(msg.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: "answer", sdp: answer, to: peerId });
}

async function handleAnswer(msg) {
  const peerId = msg.from;
  const pc = peerConnections.get(peerId);
  if (pc) await pc.setRemoteDescription(msg.sdp);
}

async function handleIce(msg) {
  const peerId = msg.from;
  const pc = peerConnections.get(peerId);
  if (pc && msg.candidate) {
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch {}
  }
}

function send(obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function updatePeers(peers) {
  peersListEl.innerHTML = "";
  speakingState.clear();

  const newPeerIds = new Set(peers.map((p) => p.id));
  const oldPeerIds = new Set(peerConnections.keys());

  // Create connections for new peers
  for (const p of peers) {
    if (!p.self && !peerConnections.has(p.id)) {
      // We're connecting to this peer for the first time
      await makeOfferTo(p.id);
    }

    const li = document.createElement("li");
    li.className = "lp-peer-card";

    const avatar = document.createElement("div");
    avatar.className = "lp-peer-avatar";

    const main = document.createElement("div");
    main.className = "lp-peer-main";

    const nameEl = document.createElement("div");
    nameEl.className = "lp-peer-name";
    nameEl.textContent = p.nick;

    const metaEl = document.createElement("div");
    metaEl.className = "lp-peer-meta";
    metaEl.textContent = p.self === p.id ? "You" : "Connected";

    main.appendChild(nameEl);
    main.appendChild(metaEl);

    li.appendChild(avatar);
    li.appendChild(main);

    peersListEl.appendChild(li);

    speakingState.set(p.id, {
      cardEl: li,
      analyser: null,
      source: null,
      self: p.self === p.id,
    });
  };

  // Clean up removed peers
  for (const peerId of oldPeerIds) {
    if (!newPeerIds.has(peerId)) {
      const pc = peerConnections.get(peerId);
      if (pc) pc.close();
      peerConnections.delete(peerId);
      remoteStreams.delete(peerId);
      speakingState.delete(peerId);
    }
  }

  // Attach analyser for self
  const selfPeer = [...speakingState.values()].find((s) => s.self);
  if (selfPeer) attachSpeakingAnalyser(selfPeer, localStream, true);

  // Attach analysers for remote streams already received
  for (const [peerId, stream] of remoteStreams.entries()) {
    const peerState = speakingState.get(peerId);
    if (peerState && !peerState.analyser) {
      attachSpeakingAnalyser(peerState, stream, false);
    }
  }
}

function attachRemoteStream(peerId, stream) {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = stream;
  document.body.appendChild(audio);

  const peerState = speakingState.get(peerId);
  if (peerState && !peerState.analyser) {
    attachSpeakingAnalyser(peerState, stream, false);
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
    const speaking = avg > 40;

    peerState.cardEl.classList.toggle(
      isSelf ? "lp-speaking-self" : "lp-speaking-other",
      speaking
    );

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

function swapLocalStream(newStream) {
  localStream.getTracks().forEach((t) => t.stop());
  localStream = newStream;

  for (const pc of peerConnections.values()) {
    localStream.getTracks().forEach((track) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
      if (sender) sender.replaceTrack(track);
    });
  }

  const selfPeer = [...speakingState.values()].find((s) => s.self);
  if (selfPeer) attachSpeakingAnalyser(selfPeer, localStream, true);
}

function cleanupAndLeave() {
  ws?.close();
  for (const pc of peerConnections.values()) {
    pc.close();
  }
  peerConnections.clear();
  localStream?.getTracks().forEach((t) => t.stop());
  window.location.href = "index.html";
}
