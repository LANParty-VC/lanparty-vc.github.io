// === REAL 3D STARFIELD ENGINE ===
(function createStarfield() {
  const canvas = document.createElement("canvas");
  canvas.className = "lp-starfield";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");

  let stars = [];
  const STAR_COUNT = 1000;       // number of stars
  const MAX_DEPTH = 1200;        // depth of field
  const SPEED = 0.6;            // star movement speed

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function initStars() {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * canvas.width - canvas.width / 2,
        y: Math.random() * canvas.height - canvas.height / 2,
        z: Math.random() * MAX_DEPTH,
      });
    }
  }

  function animate() {
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let star of stars) {
      star.z -= SPEED;
      if (star.z <= 0) {
        star.x = Math.random() * canvas.width - canvas.width / 2;
        star.y = Math.random() * canvas.height - canvas.height / 2;
        star.z = MAX_DEPTH;
      }

      const k = 128 / star.z;
      const px = star.x * k + canvas.width / 2;
      const py = star.y * k + canvas.height / 2;

      if (px >= 0 && px <= canvas.width && py >= 0 && py <= canvas.height) {
        const size = (1 - star.z / MAX_DEPTH) * 2.2;
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
