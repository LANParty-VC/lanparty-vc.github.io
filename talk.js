// talk.js — LANParty VC
// Handles WebRTC mesh + Firebase signaling for the voice room

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ------------------------------------------------------------
//  Firebase Setup (INSERT YOUR CONFIG HERE)
// ------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBkChPbspDsjeaLVjYOukxvJT6GuxMRpu8",
  authDomain: "lan-party-vc.firebaseapp.com",
  projectId: "lan-party-vc",
  storageBucket: "lan-party-vc.firebasestorage.app",
  messagingSenderId: "806162001032",
  appId: "1:806162001032:web:34d697602bb111d04e033d",
  measurementId: "G-HC648R00K1"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ------------------------------------------------------------
//  DOM Elements
// ------------------------------------------------------------
const joinBtn = document.getElementById("joinBtn");
const leaveBtn = document.getElementById("leaveBtn");
const muteBtn = document.getElementById("muteBtn");
const statusEl = document.getElementById("status");
const peersEl = document.getElementById("peers");
const logEl = document.getElementById("log");
const roomIdEl = document.getElementById("roomId");

// ------------------------------------------------------------
//  State
// ------------------------------------------------------------
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");

let peerId = crypto.randomUUID();
let localStream = null;
let muted = false;
let joined = false;

const peerConnections = new Map(); // peerId → RTCPeerConnection

// ------------------------------------------------------------
//  UI Helpers
// ------------------------------------------------------------
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

// ------------------------------------------------------------
//  WebRTC Setup
// ------------------------------------------------------------
function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  });

  // Add local audio tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = async (event) => {
    if (event.candidate) {
      await sendSignal({
        type: "candidate",
        from: peerId,
        to: remoteId,
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
    log(`Received audio from ${remoteId}`);
  };

  pc.onconnectionstatechange = () => {
    log(`PC(${remoteId}) state: ${pc.connectionState}`);
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      peerConnections.delete(remoteId);
      renderPeers();
    }
  };

  peerConnections.set(remoteId, pc);
  renderPeers();
  return pc;
}

// ------------------------------------------------------------
//  Firestore Signaling
// ------------------------------------------------------------
async function sendSignal(payload) {
  const signalsCol = collection(db, "rooms", roomId, "signals");
  await addDoc(signalsCol, {
    ...payload,
    ts: serverTimestamp()
  });
}

function listenForSignals() {
  const signalsCol = collection(db, "rooms", roomId, "signals");
  const q = query(signalsCol, where("to", "in", [peerId, "all"]));

  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;

      const data = change.doc.data();
      const { type, from } = data;

      if (from === peerId) continue;

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
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      } else if (type === "candidate") {
        const pc = peerConnections.get(from);
        if (!pc) return;
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          log(`ICE error from ${from}: ${e}`);
        }
      }
    }
  });
}

function listenForPeers() {
  const peersCol = collection(db, "rooms", roomId, "peers");

  onSnapshot(peersCol, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const data = change.doc.data();
      const id = data.id;

      if (id === peerId) continue;

      if (change.type === "added") {
        log(`Peer joined: ${id}`);

        // Only the lexicographically smaller ID initiates
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
        if (pc) pc.close();
        peerConnections.delete(id);
        renderPeers();
      }
    }
  });
}

// ------------------------------------------------------------
//  Join / Leave Logic
// ------------------------------------------------------------
async function join() {
  if (joined) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("Microphone access denied");
    return;
  }

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
}

async function leave() {
  if (!joined) return;

  const peerDoc = doc(db, "rooms", roomId, "peers", peerId);
  await deleteDoc(peerDoc);

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
  log("Left room");
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  muteBtn.textContent = muted ? "Unmute" : "Mute";
}

// ------------------------------------------------------------
//  Wire Up UI
// ------------------------------------------------------------
roomIdEl.textContent = "Room: " + roomId.slice(0, 12) + "…";

joinBtn.onclick = () => join();
leaveBtn.onclick = () => leave();
muteBtn.onclick = () => toggleMute();

setStatus("Idle");
