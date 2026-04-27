// app.js
// LANParty VC – Firebase + WebRTC mesh (small groups)

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// TODO: replace with your Firebase project config
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "SENDER_ID",
  appId: "APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- DOM ---
const joinBtn = document.getElementById("joinBtn");
const leaveBtn = document.getElementById("leaveBtn");
const muteBtn = document.getElementById("muteBtn");
const statusEl = document.getElementById("status");
const peersEl = document.getElementById("peers");
const logEl = document.getElementById("log");
const networkInfoEl = document.getElementById("networkInfo");

// --- State ---
let localStream = null;
let muted = false;
let joined = false;
let peerId = crypto.randomUUID();
let networkId = null; // hashed public IP
let roomId = null;    // same as networkId for now

// peerId -> RTCPeerConnection
const peerConnections = new Map();

// --- Helpers ---
function log(msg) {
  console.log(msg);
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setNetworkInfo(text) {
  networkInfoEl.textContent = text;
}

function renderPeers() {
  peersEl.innerHTML = "";
  for (const [id, pc] of peerConnections.entries()) {
    const div = document.createElement("div");
    div.className = "peer";
    const dot = document.createElement("div");
    dot.className = "peer-dot";
    div.appendChild(dot);
    const label = document.createElement("span");
    label.textContent = id === peerId ? "You" : id.slice(0, 6);
    div.appendChild(label);
    peersEl.appendChild(div);
  }
}

// Simple SHA-256 hash of a string → hex
async function sha256(str) {
  const enc = new TextEncoder();
  const data = enc.encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Get public IP (ipify) and derive networkId
async function detectNetwork() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    const ip = data.ip;
    const hash = await sha256(ip);
    networkId = hash;
    roomId = networkId;
    setNetworkInfo(`Network fingerprint: ${hash.slice(0, 10)}…`);
    log(`Public IP: ${ip}, networkId: ${hash}`);
  } catch (e) {
    log("Failed to detect public IP / network: " + e);
    setNetworkInfo("Network detection failed");
  }
}

// --- WebRTC setup ---
function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
      // No TURN for now – mostly direct
    ]
  });

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = async (event) => {
    if (event.candidate) {
      await sendSignal({
        type: "candidate",
        to: remoteId,
        from: peerId,
        candidate: event.candidate.toJSON()
      });
    }
  };

  pc.ontrack = (event) => {
    const [remoteStream] = event.streams;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = remoteStream;
    document.body.appendChild(audio);
    log(`Received audio track from ${remoteId}`);
  };

  pc.onconnectionstatechange = () => {
    log(`PC(${remoteId}) state: ${pc.connectionState}`);
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
      peerConnections.delete(remoteId);
      renderPeers();
    }
  };

  peerConnections.set(remoteId, pc);
  renderPeers();
  return pc;
}

// --- Signaling via Firestore ---
// Collection: rooms/{roomId}/signals
async function sendSignal(payload) {
  if (!roomId) return;
  const signalsCol = collection(db, "rooms", roomId, "signals");
  await addDoc(signalsCol, {
    ...payload,
    ts: serverTimestamp()
  });
}

// Listen for signals addressed to us
function listenForSignals() {
  if (!roomId) return;
  const signalsCol = collection(db, "rooms", roomId, "signals");
  const q = query(signalsCol, where("to", "in", [peerId, "all"]));

  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      const data = change.doc.data();
      const { type, from, to } = data;
      if (from === peerId) continue; // ignore our own

      if (type === "offer") {
        log(`Got offer from ${from}`);
        let pc = peerConnections.get(from);
        if (!pc) pc = createPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({
          type: "answer",
          from: peerId,
          to: from,
          sdp: answer.toJSON()
        });
      } else if (type === "answer") {
        log(`Got answer from ${from}`);
        const pc = peerConnections.get(from);
        if (!pc) {
          log(`No PC for ${from} when answer arrived`);
          continue;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (type === "candidate") {
        const pc = peerConnections.get(from);
        if (!pc) {
          log(`No PC for ${from} when candidate arrived`);
          continue;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          log(`Error adding ICE candidate from ${from}: ${e}`);
        }
      }
    }
  });
}

// When we see new peers in the room, connect to them
function listenForPeers() {
  if (!roomId) return;
  const peersCol = collection(db, "rooms", roomId, "peers");
  onSnapshot(peersCol, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const data = change.doc.data();
      const id = data.id;
      if (id === peerId) continue;

      if (change.type === "added") {
        log(`Peer joined: ${id}`);
        // To avoid double-offer, only the lexicographically smaller ID calls
        if (peerId < id) {
          const pc = createPeerConnection(id);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal({
            type: "offer",
            from: peerId,
            to: id,
            sdp: offer.toJSON()
          });
        }
      } else if (change.type === "removed") {
        log(`Peer left: ${id}`);
        const pc = peerConnections.get(id);
        if (pc) {
          pc.close();
          peerConnections.delete(id);
          renderPeers();
        }
      }
    }
  });
}

// --- Join / leave ---
async function join() {
  if (joined) return;
  await detectNetwork();
  if (!networkId) {
    alert("Could not detect network. Cannot join.");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    alert("Microphone access denied.");
    log("getUserMedia error: " + e);
    return;
  }

  // Register ourselves as a peer in this room
  const peerDoc = doc(db, "rooms", roomId, "peers", peerId);
  await setDoc(peerDoc, {
    id: peerId,
    joinedAt: serverTimestamp()
  });

  listenForSignals();
  listenForPeers();

  joined = true;
  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  muteBtn.disabled = false;
  setStatus("In voice");
  log(`Joined room ${roomId}`);
  renderPeers();
}

async function leave() {
  if (!joined) return;
  joined = false;

  // Remove our peer doc
  const peerDoc = doc(db, "rooms", roomId, "peers", peerId);
  try {
    await setDoc(peerDoc, { id: peerId, leftAt: serverTimestamp() });
  } catch (e) {
    log("Error marking peer left: " + e);
  }

  // Close all peer connections
  for (const [id, pc] of peerConnections.entries()) {
    pc.close();
  }
  peerConnections.clear();
  renderPeers();

  // Stop local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  muteBtn.disabled = true;
  setStatus("Idle");
  log("Left room");
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  muteBtn.textContent = muted ? "Unmute" : "Mute";
}

// --- Wire up UI ---
joinBtn.addEventListener("click", () => {
  join().catch(e => log("Join error: " + e));
});

leaveBtn.addEventListener("click", () => {
  leave().catch(e => log("Leave error: " + e));
});

muteBtn.addEventListener("click", () => {
  toggleMute();
});

// Initial
setStatus("Idle");
detectNetwork().catch(() => {});
