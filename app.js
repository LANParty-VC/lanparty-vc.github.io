// === STARFIELD ENGINE ===
(function createStarfield() {
  const canvas = document.createElement("canvas");
  canvas.className = "lp-starfield";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");

  let stars = [];
  const STAR_COUNT = 350;
  const SPEED = 0.05;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function initStars() {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        z: Math.random() * canvas.width,
      });
    }
  }

  function animate() {
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let star of stars) {
      star.z -= SPEED;
      if (star.z <= 0) star.z = canvas.width;

      const k = 128.0 / star.z;
      const px = star.x * k + canvas.width / 2;
      const py = star.y * k + canvas.height / 2;

      if (px >= 0 && px <= canvas.width && py >= 0 && py <= canvas.height) {
        const size = (1 - star.z / canvas.width) * 2;
        ctx.fillStyle = "white";
        ctx.fillRect(px, py, size, size);
      }
    }

    requestAnimationFrame(animate);
  }

  window.addEventListener("resize", () => {
    resize();
    initStars();
  });

  resize();
  initStars();
  animate();
})();


(() => {
  const form = document.getElementById("join-form");
  const nickInput = document.getElementById("nickname");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const nick = nickInput.value.trim();
    if (!nick) return;

    const params = new URLSearchParams({ nick });
    window.location.href = `talk.html?${params.toString()}`;
  });
})();
