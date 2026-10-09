const SIGNAL_URL = "wss://lanpartyvc-signal.arahomeschool23.workers.dev";

let ws;
let peerConnections = new Map(); // peerId -> RTCPeerConnection
let remoteStreams = new Map(); // peerId -> MediaStream
let pendingIceCandidates = new Map(); // peerId -> RTCIceCandidate[]
let remoteAudioPlayers = new Map(); // peerId -> audio element and visible controls
let localStream;
let nickname;
let myId;
let roomCode;
let roomMode;
let isMuted = false;
let audioContext; // Shared audio context for analysis
let availableAudioDevices = [];
let currentDeviceIndex = 0;

const roomTitleEl = document.getElementById("room-title");
const userLabelEl = document.getElementById("user-label");
const statusEl = document.getElementById("status");
const peersListEl = document.getElementById("peers-list");

const muteBtn = document.getElementById("mute-btn");
const deviceBtn = document.getElementById("device-btn");
const copyRoomBtn = document.getElementById("copy-room-btn");
const leaveBtn = document.getElementById("leave-btn");

const speakingState = new Map(); // peerId -> { cardEl, analyser, source, self }

init();

async function init() {
  setupUI();

  const params = new URLSearchParams(location.search);
  nickname = params.get("nick") || "Guest";
  roomCode = params.get("room") || "";
  roomMode = params.get("mode") === "network" ? "network" : "code";

  if (roomMode === "code" && !/^\d{6}$/.test(roomCode)) {
    statusEl.textContent = "Invalid room code. Return to the home page and join a room.";
    return;
  }

  userLabelEl.textContent = `You are: ${nickname}`;
  roomTitleEl.textContent = roomMode === "network" ? "Automatic network room" : roomCode;
  copyRoomBtn.hidden = roomMode !== "code";

  try {
    statusEl.textContent = "Requesting microphone access…";
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    muteBtn.disabled = false;
    deviceBtn.disabled = false;
  } catch (err) {
    console.error("Microphone access error:", err);
    statusEl.textContent = "Microphone access is required to join.";
    return;
  }

  await setupWebSocket();
}

function setupUI() {
  muteBtn.onclick = () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
    muteBtn.textContent = isMuted ? "Unmute" : "Mute";
  };

  copyRoomBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      copyRoomBtn.textContent = "Copied";
      setTimeout(() => (copyRoomBtn.textContent = "Copy code"), 1500);
    } catch (err) {
      console.error("Could not copy room code:", err);
      statusEl.textContent = `Share room code ${roomCode} with your friends.`;
    }
  };

  deviceBtn.onclick = async () => {
    if (!localStream) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableAudioDevices = devices.filter((d) => d.kind === "audioinput");

      if (availableAudioDevices.length === 0) {
        statusEl.textContent = "No microphones found";
        return;
      }

      const activeDeviceId = localStream.getAudioTracks()[0]?.getSettings().deviceId;
      if (availableAudioDevices.length === 1 ||
          (availableAudioDevices.length > 1 &&
           availableAudioDevices.every((device) => device.deviceId === activeDeviceId))) {
        statusEl.textContent = "Only one microphone available";
        return;
      }

      const activeIndex = availableAudioDevices.findIndex(
        (device) => device.deviceId === activeDeviceId,
      );
      currentDeviceIndex = (activeIndex + 1) % availableAudioDevices.length;
      const selectedDevice = availableAudioDevices[currentDeviceIndex];
      const deviceLabel = selectedDevice.label || `Microphone ${currentDeviceIndex + 1}`;

      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedDevice.deviceId } },
      });
      await swapLocalStream(newStream);
      statusEl.textContent = `Switched to: ${deviceLabel}`;
    } catch (err) {
      statusEl.textContent = `Mic switch failed: ${err.message || "could not access that microphone"}`;
      console.error("Device switch error:", err);
    }
  };

  leaveBtn.onclick = () => cleanupAndLeave();
}

async function detectNetworkRoom() {
  const response = await fetch("https://api4.ipify.org?format=json", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Network lookup failed with HTTP ${response.status}.`);
  }

  const result = await response.json();
  if (!isValidIpv4(result.ip)) {
    throw new Error("Network lookup did not return a valid IPv4 address.");
  }
  return `network-${result.ip}`;
}

function isValidIpv4(value) {
  if (typeof value !== "string") return false;
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

async function setupWebSocket() {
  let roomKey = roomCode;
  if (roomMode === "network") {
    statusEl.textContent = "Finding your network…";
    try {
      roomKey = await detectNetworkRoom();
    } catch (err) {
      console.error("[NETWORK] Could not detect public IPv4:", err);
      statusEl.textContent =
        "Automatic network joining needs IPv4 lookup access. Try a six-digit room code.";
      return;
    }
  } else {
    statusEl.textContent = `Joining room ${roomCode}…`;
  }

  const signalUrl = new URL(SIGNAL_URL);
  signalUrl.searchParams.set("nick", nickname);
  signalUrl.searchParams.set("net", roomKey);
  if (roomMode === "code") signalUrl.searchParams.set("room", roomCode);
  ws = new WebSocket(signalUrl);

  ws.onopen = () => {
    statusEl.textContent =
      roomMode === "network"
        ? "Connected to your network room"
        : `Connected to room ${roomCode}`;
    console.log("[WS] WebSocket connected");
    setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN && speakingState.size <= 1) {
        send({ type: "get-peers" });
      }
    }, 3000);
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.error("[WS] Ignoring invalid signaling message:", err);
      return;
    }
    console.log("Message received:", msg.type, msg);

    switch (msg.type) {
      case "room-info":
        myId = String(msg.myId);
        // If peers arrived before we had myId, process them now
        if (window._pendingPeers) {
          console.log("Processing pending peers after room-info");
          await updatePeers(window._pendingPeers);
          window._pendingPeers = null;
        }
        break;

      case "peers":
        console.log(`[WS] Peers update - got ${msg.peers.length} peer(s):`);
        msg.peers.forEach((p) => {
          console.log(`      - ${p.nick} (${p.id}, self=${p.self})`);
        });
        // If we don't yet know our assigned myId, defer processing briefly
        if (!myId) {
          console.log("Peers arrived before myId; deferring updatePeers until room-info");
          window._pendingPeers = msg.peers;
        } else {
          await updatePeers(msg.peers);
        }
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

      case "speaking":
        handleSpeakingState(msg.from, msg.speaking);
        break;

      case "error":
        statusEl.textContent = msg.message || "The signaling service rejected the room connection.";
        break;
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "Disconnected from the signaling server.";
    console.log("[WS] WebSocket closed");
  };

  ws.onerror = (event) => {
    console.error("[WS] WebSocket error:", event);
    statusEl.textContent = "Could not connect to the signaling server.";
  };
}

function createPeerConnectionTo(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      statusEl.textContent = "Peer connection failed. Try joining again or use a room code.";
    }
  };

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    const stream =
      event.streams[0] || remoteStreams.get(peerId) || new MediaStream();
    if (!event.streams[0] && !stream.getTracks().includes(event.track)) {
      stream.addTrack(event.track);
    }
    remoteStreams.set(peerId, stream);
    attachRemoteStream(peerId, stream);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "ice", candidate: event.candidate, to: peerId });
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

// Helper to retry setRemoteDescription when browser reports wrong state transiently
async function safeSetRemoteDescription(pc, desc) {
  const maxRetries = 6;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await pc.setRemoteDescription(desc);
      return;
    } catch (e) {
      console.warn(`[PEER] setRemoteDescription failed (attempt ${attempt + 1}):`, e);
      if (e && e.name !== "InvalidStateError") throw e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  // last try, let it throw
  await pc.setRemoteDescription(desc);
}

async function makeOfferTo(peerId) {
  let pc = peerConnections.get(peerId);
  if (!pc) pc = createPeerConnectionTo(peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", sdp: pc.localDescription, to: peerId });
}

async function handleOffer(msg) {
  const peerId = String(msg.from);
  let pc = peerConnections.get(peerId);
  if (!pc) pc = createPeerConnectionTo(peerId);
  try {
    await safeSetRemoteDescription(pc, msg.sdp);
    await flushIceCandidates(peerId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "answer", sdp: pc.localDescription, to: peerId });
  } catch (e) {
    console.error(`[PEER] Failed to answer offer from ${peerId}:`, e);
  }
}

async function handleAnswer(msg) {
  const peerId = String(msg.from);
  const pc = peerConnections.get(peerId);
  if (pc) {
    try {
      await safeSetRemoteDescription(pc, msg.sdp);
      await flushIceCandidates(peerId, pc);
    } catch (e) {
      console.error(`[PEER] Failed to apply answer from ${peerId}:`, e);
    }
  }
}

async function handleIce(msg) {
  const peerId = String(msg.from);
  const pc = peerConnections.get(peerId);
  if (!msg.candidate) return;
  if (!pc || !pc.remoteDescription) {
    const candidates = pendingIceCandidates.get(peerId) || [];
    candidates.push(msg.candidate);
    pendingIceCandidates.set(peerId, candidates);
    return;
  }
  try {
    await pc.addIceCandidate(msg.candidate);
  } catch (e) {
    console.error(`Error adding ICE candidate from ${peerId}:`, e);
  }
}

async function flushIceCandidates(peerId, pc) {
  const candidates = pendingIceCandidates.get(peerId) || [];
  pendingIceCandidates.delete(peerId);
  for (const candidate of candidates) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.error(`Error adding queued ICE candidate from ${peerId}:`, e);
    }
  }
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function updatePeers(peers) {
  if (!Array.isArray(peers)) return;
  peersListEl.innerHTML = "";
  const newPeerIds = new Set(peers.map((p) => String(p.id)));
  const oldPeerIds = new Set(speakingState.keys());

  for (const p of peers) {
    const peerId = String(p.id);
    const isSelf = peerId === String(myId);
    if (
      !isSelf &&
      !peerConnections.has(peerId) &&
      String(myId).localeCompare(peerId) < 0
    ) {
      await makeOfferTo(peerId);
    }
  }

  for (const p of peers) {
    const peerId = String(p.id);
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
    const isSelf = peerId === String(myId);
    metaEl.textContent = isSelf ? "You" : "Connected";

    main.appendChild(nameEl);
    main.appendChild(metaEl);
    li.appendChild(avatar);
    li.appendChild(main);
    if (!isSelf) {
      li.appendChild(ensureRemoteAudioPlayer(peerId).controls);
    }
    peersListEl.appendChild(li);

    if (!speakingState.has(peerId)) {
      speakingState.set(peerId, {
        cardEl: li,
        analyser: null,
        source: null,
        animId: null,
        self: isSelf,
      });
    } else {
      const state = speakingState.get(peerId);
      state.cardEl = li;
    }
  }

  for (const peerId of oldPeerIds) {
    if (!newPeerIds.has(peerId)) {
      const pc = peerConnections.get(peerId);
      if (pc) pc.close();
      const peerState = speakingState.get(peerId);
      if (peerState?.animId) cancelAnimationFrame(peerState.animId);
      peerState?.source?.disconnect();
      peerConnections.delete(peerId);
      remoteStreams.delete(peerId);
      pendingIceCandidates.delete(peerId);
      const audioPlayer = remoteAudioPlayers.get(peerId);
      audioPlayer?.audio.pause();
      if (audioPlayer) audioPlayer.audio.srcObject = null;
      audioPlayer?.controls.remove();
      remoteAudioPlayers.delete(peerId);
      speakingState.delete(peerId);
    }
  }

  for (const [peerId, peerState] of speakingState.entries()) {
    if (peerState.self && !peerState.analyser && localStream) {
      attachSpeakingAnalyser(peerState, localStream, true);
    }
    if (!peerState.self && !peerState.analyser && remoteStreams.has(peerId)) {
      attachSpeakingAnalyser(peerState, remoteStreams.get(peerId), false);
    }
  }
}

function attachRemoteStream(peerId, stream) {
  remoteStreams.set(peerId, stream);
  const player = ensureRemoteAudioPlayer(peerId);
  player.audio.srcObject = stream;
  player.playButton.disabled = false;
  player.volumeInput.disabled = false;
  player.status.textContent = "Audio ready";
  const peerState = speakingState.get(peerId);
  if (peerState && !player.controls.isConnected) {
    peerState.cardEl.appendChild(player.controls);
  }
  player.audio.play().then(() => {
    player.playButton.textContent = "Pause";
    player.status.textContent = "Playing";
  }).catch((err) => {
    console.warn(`[AUDIO] Could not autoplay audio from ${peerId}:`, err);
    player.status.textContent = "Press Play to hear this participant";
    player.playButton.textContent = "Play";
  });

  if (peerState && !peerState.analyser && stream.getAudioTracks().length) {
    attachSpeakingAnalyser(peerState, stream, false);
  }
}

function ensureRemoteAudioPlayer(peerId) {
  let player = remoteAudioPlayers.get(peerId);
  if (player) return player;

  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.preload = "none";
  audio.setAttribute("aria-label", "Remote participant audio output");

  const controls = document.createElement("div");
  controls.className = "lp-peer-audio-controls";

  const playButton = document.createElement("button");
  playButton.className = "lp-button lp-button-secondary lp-audio-play";
  playButton.type = "button";
  playButton.textContent = "Waiting for audio";
  playButton.disabled = true;
  playButton.addEventListener("click", async () => {
    if (audio.paused) {
      try {
        await audio.play();
        playButton.textContent = "Pause";
        status.textContent = "Playing";
      } catch (err) {
        console.error(`[AUDIO] Could not play audio from ${peerId}:`, err);
        status.textContent = "Playback failed; check browser audio permissions.";
      }
    } else {
      audio.pause();
      playButton.textContent = "Play";
      status.textContent = "Paused";
    }
  });

  const volumeLabel = document.createElement("label");
  volumeLabel.className = "lp-peer-volume";
  volumeLabel.textContent = "Volume";

  const volumeInput = document.createElement("input");
  volumeInput.type = "range";
  volumeInput.min = "0";
  volumeInput.max = "1";
  volumeInput.step = "0.05";
  volumeInput.value = "1";
  volumeInput.disabled = true;
  volumeInput.setAttribute("aria-label", "Participant volume");
  volumeInput.addEventListener("input", () => {
    audio.volume = Number(volumeInput.value);
  });
  volumeLabel.appendChild(volumeInput);

  const status = document.createElement("span");
  status.className = "lp-peer-audio-status";
  status.textContent = "Waiting for audio…";
  controls.append(playButton, volumeLabel, status);
  player = { audio, controls, playButton, volumeInput, status };
  remoteAudioPlayers.set(peerId, player);
  return player;
}

function attachSpeakingAnalyser(peerState, stream, isSelf) {
  if (!stream.getAudioTracks().length) return;
  if (peerState.animId) cancelAnimationFrame(peerState.animId);
  peerState.source?.disconnect();

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioContext.state === "suspended") {
    audioContext.resume().catch((err) => console.warn("Could not resume audio analysis:", err));
  }

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  peerState.analyser = analyser;
  peerState.source = source;

  const data = new Uint8Array(analyser.frequencyBinCount);
  let animId;
  let lastSpeakingState = false;

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const speaking = avg > 30;

    peerState.cardEl.classList.toggle(
      isSelf ? "lp-speaking-self" : "lp-speaking-other",
      speaking
    );

    if (isSelf && speaking !== lastSpeakingState) {
      lastSpeakingState = speaking;
      send({ type: "speaking", speaking: speaking, from: myId });
    }

    animId = requestAnimationFrame(tick);
  }

  tick();
  peerState.animId = animId;
}

async function swapLocalStream(newStream) {
  const previousStream = localStream;
  const previousTrack = previousStream.getAudioTracks()[0];
  const newTrack = newStream.getAudioTracks()[0];
  if (!newTrack) {
    newStream.getTracks().forEach((track) => track.stop());
    throw new Error("The selected microphone did not provide an audio track.");
  }
  newTrack.enabled = !isMuted;

  const replacedSenders = [];
  try {
    for (const pc of peerConnections.values()) {
      const sender = pc.getSenders().find((candidate) => candidate.track?.kind === "audio");
      if (sender) {
        await sender.replaceTrack(newTrack);
        replacedSenders.push(sender);
      }
    }
  } catch (error) {
    try {
      await Promise.all(
        replacedSenders.map((sender) => sender.replaceTrack(previousTrack)),
      );
    } catch (rollbackError) {
      console.error("Could not restore the previous microphone track:", rollbackError);
    }
    newStream.getTracks().forEach((track) => track.stop());
    throw error;
  }

  localStream = new MediaStream([newTrack]);
  previousStream.getTracks().forEach((track) => track.stop());

  const selfPeer = [...speakingState.values()].find((s) => s.self);
  if (selfPeer) attachSpeakingAnalyser(selfPeer, localStream, true);
}


function handleSpeakingState(peerId, speaking) {
  console.log(`[SPEAK] Peer ${peerId} is ${speaking ? "speaking" : "quiet"}`);
  const peerState = speakingState.get(String(peerId));
  if (peerState) {
    peerState.cardEl.classList.toggle("lp-speaking-other", speaking);
  }
}

function cleanupAndLeave() {
  ws?.close();
  for (const pc of peerConnections.values()) {
    pc.close();
  }
  peerConnections.clear();
  for (const state of speakingState.values()) {
    if (state.animId) cancelAnimationFrame(state.animId);
    state.source?.disconnect();
  }
  speakingState.clear();
  localStream?.getTracks().forEach((t) => t.stop());
  for (const player of remoteAudioPlayers.values()) {
    player.audio.pause();
    player.audio.srcObject = null;
  }
  remoteAudioPlayers.clear();
  window.location.href = "index.html";
}
