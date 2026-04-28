// app.js — lobby logic

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function detectNetwork() {
  const networkEl = document.getElementById("network");
  const enterBtn = document.getElementById("enterBtn");

  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const ip = (await res.json()).ip;
    const hash = await sha256(ip);

    networkEl.innerHTML = `<span>${hash.slice(0, 12)}…</span>`;
    enterBtn.disabled = false;
    enterBtn.onclick = () => {
      window.location.href = "talk.html?room=" + hash;
    };
  } catch (e) {
    networkEl.innerHTML = `<span>Detection failed</span>`;
    enterBtn.disabled = true;
  }
}

detectNetwork();
