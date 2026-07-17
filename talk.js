const SIGNAL_URL = "wss://lanpartyvc-signal.arahomeschool23.workers.dev";

let ws;
let peerConnections = new Map(); // peerId -> RTCPeerConnection
let remoteStreams = new Map(); // peerId -> MediaStream
let localStream;
let nickname;
let myId;
let isMuted = false;
let audioContext; // Shared audio context for analysis
let availableAudioDevices = [];
let currentDeviceIndex = 0;
let cachedNetworkId = null;
let broadcastChannel = null;

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
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableAudioDevices = devices.filter((d) => d.kind === "audioinput");

      if (availableAudioDevices.length === 0) {
        statusEl.textContent = "No microphones found";
        return;
      }

      if (availableAudioDevices.length === 1) {
        statusEl.textContent = "Only one microphone available";
        return;
      }

      // Cycle to next device
      currentDeviceIndex = (currentDeviceIndex + 1) % availableAudioDevices.length;
      const selectedDevice = availableAudioDevices[currentDeviceIndex];
      const deviceLabel = selectedDevice.label || `Microphone ${currentDeviceIndex + 1}`;

      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedDevice.deviceId } },
      });
      swapLocalStream(newStream);
      statusEl.textContent = `Switched to: ${deviceLabel}`;
    } catch (err) {
      statusEl.textContent = "Mic switch failed";
      console.error("Device switch error:", err);
    }
  };

  leaveBtn.onclick = () => cleanupAndLeave();
}

function getLocalNetworkId() {
  return new Promise((resolve) => {
    // Check if we already have a cached network ID
    if (cachedNetworkId) {
      console.log("Using cached network ID:", cachedNetworkId);
      resolve(cachedNetworkId);
      return;
    }

    // Try BroadcastChannel to sync across tabs
    if (typeof BroadcastChannel !== "undefined") {
      try {
        broadcastChannel = new BroadcastChannel("lanpartyNetId");
        broadcastChannel.onmessage = (event) => {
          if (event.data.netId && !cachedNetworkId) {
            cachedNetworkId = event.data.netId;
            console.log("Received network ID from broadcast:", cachedNetworkId);
            resolve(cachedNetworkId);
          }
        };
      } catch (e) {
        console.log("BroadcastChannel not available");
      }
    }

    // Detect local IP via WebRTC
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        const fallback = "local-" + Math.random().toString(36).substr(2, 9);
        cachedNetworkId = fallback;
        if (broadcastChannel) broadcastChannel.postMessage({ netId: fallback });
        resolve(fallback);
      });

    pc.onicecandidate = (ice) => {
      if (!ice || !ice.candidate || cachedNetworkId) return;
      const match = ice.candidate.candidate.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
      if (match) {
        cachedNetworkId = match[1];
        console.log("Detected network ID:", cachedNetworkId);
        if (broadcastChannel) broadcastChannel.postMessage({ netId: cachedNetworkId });
        resolve(cachedNetworkId);
        pc.close();
      }
    };

    setTimeout(() => {
      if (cachedNetworkId) return;
      const fallback = "local-" + Math.random().toString(36).substr(2, 9);
      cachedNetworkId = fallback;
      console.log("Network ID timeout, using fallback:", fallback);
      if (broadcastChannel) broadcastChannel.postMessage({ netId: fallback });
      resolve(fallback);
      try {
        pc.close();
      } catch {}
    }, 2000);
  });
}

async function setupWebSocket() {
  const networkId = await getLocalNetworkId();
  console.log("[SETUP] Network ID:", networkId);
  console.log("[SETUP] My nickname:", nickname);
  ws = new WebSocket(`${SIGNAL_URL}/?nick=${encodeURIComponent(nickname)}&net=${encodeURIComponent(networkId)}`);

  ws.onopen = () => {
    statusEl.textContent = "Connected";
    console.log("[WS] WebSocket connected");
    // Test: send a ping to verify routing works
    setTimeout(() => {
      send({ type: "test-message", data: "Testing worker connection" });
    }, 500);
    
    // Set timeout to check if we're still alone after 3 seconds
    setTimeout(() => {
      const peerCount = speakingState.size;
      console.log(`[CHECK] After 3s, peer count: ${peerCount}`);
      if (peerCount === 1) {
        console.log(`[CHECK] Still alone - requesting peer update`);
        send({ type: "get-peers" });
      }
    }, 3000);
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    console.log("Message received:", msg.type, msg);

    switch (msg.type) {
      case "room-info":
        myId = msg.myId;
        break;

      case "peers":
        console.log(`[WS] Peers update - got ${msg.peers.length} peer(s):`);
        msg.peers.forEach((p) => {
          console.log(`      - ${p.nick} (${p.id}, self=${p.self})`);
        });
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

      case "speaking":
        handleSpeakingState(msg.from, msg.speaking);
        break;
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "Disconnected.";
    console.log("[WS] WebSocket closed");
  };
}

function createPeerConnectionTo(peerId) {
  console.log(`[PEER] createPeerConnectionTo: ${peerId}`);
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  console.log(`[PEER] Adding local audio tracks to ${peerId}...`);
  const trackCount = localStream.getTracks().length;
  console.log(`[PEER] Local stream has ${trackCount} tracks`);
  if (trackCount === 0) {
    console.error(`[PEER] ERROR: No audio tracks in local stream!`);
  }
  localStream.getTracks().forEach((t, i) => {
    console.log(`[PEER]   Track ${i}: kind=${t.kind}, enabled=${t.enabled}`);
    pc.addTrack(t, localStream);
  });
  
  // Verify tracks were added
  const senders = pc.getSenders();
  console.log(`[PEER] After addTrack, peer connection has ${senders.length} senders`);
  senders.forEach((s, i) => {
    console.log(`[PEER]   Sender ${i}: kind=${s.track?.kind}, enabled=${s.track?.enabled}`);
  });

  pc.ontrack = (event) => {
    console.log(`[PEER] ontrack event from ${peerId}:`, event);
    console.log(`[PEER]   streams: ${event.streams.length}`);
    console.log(`[PEER]   tracks: ${event.track.kind}`);
    const stream = event.streams[0];
    if (stream) {
      console.log(`[PEER]   stream ID: ${stream.id}`);
      remoteStreams.set(peerId, stream);
      console.log(`[PEER] Stored remote stream for ${peerId}`);
      attachRemoteStream(peerId, stream);
    } else {
      console.error(`[PEER] No stream in ontrack event from ${peerId}`);
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`[PEER] Sending ICE candidate to ${peerId}`);
      send({ type: "ice", candidate: event.candidate, to: peerId });
    }
  };

  peerConnections.set(peerId, pc);
  console.log(`[PEER] Peer connection created for ${peerId}`);
  return pc;
}

async function makeOfferTo(peerId) {
  console.log(`makeOfferTo: ${peerId}`);
  let pc = peerConnections.get(peerId);
  if (!pc) pc = createPeerConnectionTo(peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  console.log(`Sending offer to ${peerId}`);
  send({ type: "offer", sdp: offer, to: peerId });
}

async function handleOffer(msg) {
  const peerId = msg.from;
  console.log(`handleOffer from ${peerId}`);
  let pc = peerConnections.get(peerId);
  if (!pc) pc = createPeerConnectionTo(peerId);

  await pc.setRemoteDescription(msg.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  console.log(`Sending answer to ${peerId}`);
  send({ type: "answer", sdp: answer, to: peerId });
}

async function handleAnswer(msg) {
  const peerId = msg.from;
  console.log(`handleAnswer from ${peerId}`);
  const pc = peerConnections.get(peerId);
  if (pc) await pc.setRemoteDescription(msg.sdp);
}

async function handleIce(msg) {
  const peerId = msg.from;
  const pc = peerConnections.get(peerId);
  if (pc && msg.candidate) {
    console.log(`Adding ICE candidate from ${peerId}`);
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (e) {
      console.error(`Error adding ICE candidate from ${peerId}:`, e);
    }
  }
}

function send(obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function updatePeers(peers) {
  console.log(`[UPDATE] updatePeers called with: ${peers.length} peer(s)`);
  console.log(`[UPDATE] Previous peer count: ${speakingState.size}`);
  
  if (peers.length > speakingState.size) {
    console.log(`[UPDATE] NEW PEERS DETECTED! Going from ${speakingState.size} to ${peers.length}`);
  }
  
  peersListEl.innerHTML = "";
  const newPeerIds = new Set(peers.map((p) => p.id));
  const oldPeerIds = new Set(speakingState.keys());

  // Create peer connections for new remote peers
  for (const p of peers) {
    console.log(`[UPDATE] Processing peer: ${p.nick} (id=${p.id}, self=${p.self}, isSelf=${p.self === p.id})`);
    if (!p.self && !peerConnections.has(p.id)) {
      console.log(`[UPDATE] -> CREATING CONNECTION to ${p.nick}`);
      await makeOfferTo(p.id);
    } else if (p.self === p.id) {
      console.log(`[UPDATE] -> This is me (${p.nick})`);
    } else {
      console.log(`[UPDATE] -> Already have connection to ${p.nick}`);
    }
  }

  // Display all peers
  for (const p of peers) {
    console.log(`Displaying peer: ${p.nick} (${p.id}, self=${p.self === p.id})`);
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
    const isSelf = p.self === p.id;
    metaEl.textContent = isSelf ? "You" : "Connected";

    main.appendChild(nameEl);
    main.appendChild(metaEl);
    li.appendChild(avatar);
    li.appendChild(main);
    peersListEl.appendChild(li);
    console.log(`  Added UI for ${p.nick}`);

    // Create or update speaking state
    if (!speakingState.has(p.id)) {
      console.log(`  Created speaking state for ${p.id}`);
      speakingState.set(p.id, {
        cardEl: li,
        analyser: null,
        source: null,
        animId: null,
        self: isSelf,
      });
    } else {
      const state = speakingState.get(p.id);
      state.cardEl = li;
      console.log(`  Updated cardEl for existing peer ${p.id}`);
    }
  }

  // Clean up removed peers
  for (const peerId of oldPeerIds) {
    if (!newPeerIds.has(peerId)) {
      const pc = peerConnections.get(peerId);
      if (pc) pc.close();
      const peerState = speakingState.get(peerId);
      if (peerState && peerState.animId) cancelAnimationFrame(peerState.animId);
      peerConnections.delete(peerId);
      remoteStreams.delete(peerId);
      speakingState.delete(peerId);
    }
  }

  // Start analysers
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
  console.log(`[AUDIO] attachRemoteStream for ${peerId}`);
  console.log(`[AUDIO] Stream ID: ${stream.id}, tracks: ${stream.getTracks().length}`);
  stream.getTracks().forEach((t, i) => {
    console.log(`[AUDIO]   Track ${i}: kind=${t.kind}, enabled=${t.enabled}`);
  });
  
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = stream;
  document.body.appendChild(audio);
  console.log(`[AUDIO] Audio element created for ${peerId}, autoplay=${audio.autoplay}`);

  const peerState = speakingState.get(peerId);
  if (peerState && !peerState.analyser) {
    console.log(`[AUDIO] Attaching analyser for ${peerId}`);
    attachSpeakingAnalyser(peerState, stream, false);
  } else if (!peerState) {
    console.error(`[AUDIO] No peer state found for ${peerId}`);
  }
}

function attachSpeakingAnalyser(peerState, stream, isSelf) {
  console.log(`[ANALYSER] attachSpeakingAnalyser (self=${isSelf})`);
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    console.log(`[ANALYSER] Created audio context, state: ${audioContext.state}`);
  }

  // Resume audio context on first interaction
  if (audioContext.state === "suspended") {
    console.log(`[ANALYSER] Resuming suspended audio context`);
    audioContext.resume();
  }

  console.log(`[ANALYSER] Creating media stream source, stream tracks: ${stream.getTracks().length}`);
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

    // Broadcast speaking state when it changes (only for self)
    if (isSelf && speaking !== lastSpeakingState) {
      lastSpeakingState = speaking;
      console.log(`[BROADCAST] You are now ${speaking ? "speaking" : "quiet"}`);
      send({ type: "speaking", speaking: speaking, from: myId });
    }

    animId = requestAnimationFrame(tick);
  }

  tick();
  peerState.animId = animId;
  console.log(`[ANALYSER] Analyser attached and running`);
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

function handleSpeakingState(peerId, speaking) {\n  console.log(`[SPEAK] Peer ${peerId} is ${speaking ? \"speaking\" : \"quiet\"}`);\n  const peerState = speakingState.get(peerId);\n  if (peerState) {\n    peerState.cardEl.classList.toggle(\"lp-speaking-other\", speaking);\n  }\n}\n\nfunction cleanupAndLeave() {\n  ws?.close();\n  for (const pc of peerConnections.values()) {\n    pc.close();\n  }\n  peerConnections.clear();\n  for (const state of speakingState.values()) {\n    if (state.animId) cancelAnimationFrame(state.animId);\n  }\n  speakingState.clear();\n  localStream?.getTracks().forEach((t) => t.stop());\n  window.location.href = \"index.html\";\n}
