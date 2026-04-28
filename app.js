// app.js — lobby logic

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function detectNetwork() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const ip = (await res.json()).ip;
    const hash = await sha256(ip);

    document.getElementById("network").textContent =
      "Network fingerprint: " + hash.slice(0, 12) + "…";

    const btn = document.getElementById("enterBtn");
    btn.disabled = false;
    btn.onclick = () => {
      window.location.href = "talk.html?room=" + hash;
    };
  } catch (e) {
    document.getElementById("network").textContent =
      "Network detection failed";
  }
}

detectNetwork();
