document.getElementById("join-form").addEventListener("submit", (e) => {
  e.preventDefault();

  const room = document.getElementById("room-id").value.trim();
  const nick = document.getElementById("nickname").value.trim();

  if (!room || !nick) return;

  const params = new URLSearchParams({ room, nick });
  window.location.href = `talk.html?${params.toString()}`;
});
