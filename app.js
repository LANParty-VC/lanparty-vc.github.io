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
