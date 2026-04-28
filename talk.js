const SIGNAL_URL = "wss://lanpartyvc-signal.arahomeschool23.workers.dev";

let ws, pc, localStream;
let roomId, nickname;
let isMuted = false;

const peersListEl = document.getElementById("peers-list");
const statusEl = document.getElementById("status");

init();

async function init() {
  const params = new URLSearchParams(location.search);
  roomId = params.get("room");
  nickname = params.get("nick");

  document.getElementById("room-title").textContent = `Room: ${roomId}`;
  document.getElementById("user-label").textContent = `You are: ${nickname}`;

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  setupWebSocket();
  setupUI();
}

function setupUI() {
  document.getElementById("mute-btn").onclick = () => {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    document.getElementById("mute-btn").textContent = isMuted ? "Unmute" : "Mute";
  };

  document.getElementById("leave-btn").onclick = () => {
    ws.close();
    pc?.close();
    location.href = "index.html";
  };
}

function setupWebSocket() {
  ws = new WebSocket(`${SIGNAL_URL}/?room=${roomId}&nick=${nickname}`);

  ws.onopen = () => {
    statusEl.textContent = "Connected to signaling";
    createPeerConnection();
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "peers") updatePeers(msg.peers);
    if (msg.type === "offer") await handleOffer(msg);
    if (msg.type === "answer") await handleAnswer(msg);
    if (msg.type === "ice") await handleIce(msg);
  };
}

function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (e) => {
    const audio = document.getElementById("remote") || document.createElement("audio");
    audio.id = "remote";
    audio.autoplay = true;
    audio.srcObject = e.streams[0];
    document.body.appendChild(audio);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "ice", candidate: e.candidate });
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
  if (msg.candidate) await pc.addIceCandidate(msg.candidate);
}

function send(obj) {
  ws.send(JSON.stringify(obj));
}

function updatePeers(peers) {
  peersListEl.innerHTML = "";
  peers.forEach(p => {
    const li = document.createElement("li");
    li.textContent = p.nick + (p.self === p.id ? " (You)" : "");
    peersListEl.appendChild(li);
  });
}
