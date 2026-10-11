(() => {
  "use strict";

  const canvas = document.getElementById("space-mesh");
  if (!canvas) return;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;

  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const pointer = {
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    strength: 0,
    active: false,
  };

  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let spacing = 18;
  let columns = 0;
  let rows = 0;
  let frameId = 0;

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);

    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    spacing = Math.max(13, Math.min(22, width / 86));
    columns = Math.ceil(width / spacing) + 2;
    rows = Math.ceil(height / spacing) + 2;

    if (pointer.x === 0 && pointer.y === 0) {
      pointer.x = pointer.targetX = width * 0.5;
      pointer.y = pointer.targetY = height * 0.5;
    }
  }

  function drawPointerGlow() {
    if (pointer.strength < 0.01) return;

    const radius = Math.min(280, Math.max(155, width * 0.18));
    const glow = context.createRadialGradient(
      pointer.x,
      pointer.y,
      0,
      pointer.x,
      pointer.y,
      radius,
    );
    glow.addColorStop(0, `rgba(255, 197, 130, ${0.19 * pointer.strength})`);
    glow.addColorStop(0.32, `rgba(255, 177, 105, ${0.085 * pointer.strength})`);
    glow.addColorStop(1, "rgba(255, 160, 90, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  }

  function draw(now = 0) {
    const time = motionPreference.matches ? 0 : now * 0.00042;
    const targetStrength = pointer.active && !motionPreference.matches ? 1 : 0;
    pointer.x += (pointer.targetX - pointer.x) * 0.16;
    pointer.y += (pointer.targetY - pointer.y) * 0.16;
    pointer.strength += (targetStrength - pointer.strength) * 0.11;

    context.fillStyle = "#080808";
    context.fillRect(0, 0, width, height);

    const ambient = context.createRadialGradient(
      width * 0.52,
      height * 0.5,
      0,
      width * 0.52,
      height * 0.5,
      Math.max(width, height) * 0.76,
    );
    ambient.addColorStop(0, "rgba(210, 210, 210, 0.055)");
    ambient.addColorStop(0.42, "rgba(120, 120, 120, 0.025)");
    ambient.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = ambient;
    context.fillRect(0, 0, width, height);

    drawPointerGlow();

    const pointerRadius = Math.min(300, Math.max(175, width * 0.2));
    for (let row = -1; row <= rows; row += 1) {
      const baseY = row * spacing;
      const vertical = baseY / Math.max(height, 1);
      const perspective = 0.72 + Math.max(0, Math.min(1, vertical)) * 0.42;

      for (let column = -1; column <= columns; column += 1) {
        const baseX = column * spacing;
        const phase = baseX * 0.0065 + baseY * 0.006 + time * 0.82;
        const secondary = baseX * 0.0105 - baseY * 0.003 - time * 0.64;
        const wave =
          Math.sin(phase) * 92 +
          Math.sin(secondary) * 28 +
          Math.sin(baseY * 0.01 + time * 0.42) * 8;
        const x = baseX + Math.sin(baseY * 0.006 + time * 0.25) * 3.2;
        const y = baseY + wave * perspective;
        const ridge = 0.5 + 0.5 * Math.sin(phase * 1.16 + row * 0.12);

        let localGlow = 0;
        if (pointer.strength > 0.015) {
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          localGlow = Math.max(0, 1 - distance / pointerRadius) * pointer.strength;
        }

        const alpha = Math.min(0.94, 0.2 + ridge * 0.44 + localGlow * 0.38);
        const dotRadius = 0.78 + perspective * 0.44 + ridge * 0.32 + localGlow * 0.7;
        context.beginPath();
        context.fillStyle = `rgba(242, 243, 245, ${alpha})`;
        context.arc(x, y, dotRadius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function animate(now) {
    draw(now);
    frameId = window.requestAnimationFrame(animate);
  }

  function start() {
    if (document.hidden) return;
    if (motionPreference.matches) {
      draw(0);
      return;
    }
    if (!frameId) frameId = window.requestAnimationFrame(animate);
  }

  function stop() {
    if (!frameId) return;
    window.cancelAnimationFrame(frameId);
    frameId = 0;
  }

  function movePointer(event) {
    if (motionPreference.matches) return;
    pointer.targetX = event.clientX;
    pointer.targetY = event.clientY;
    pointer.active = true;
  }

  window.addEventListener("pointermove", movePointer, { passive: true });
  window.addEventListener("pointerdown", movePointer, { passive: true });
  window.addEventListener("pointerout", (event) => {
    if (!event.relatedTarget) pointer.active = false;
  }, { passive: true });
  window.addEventListener("blur", () => {
    pointer.active = false;
  });
  window.addEventListener("resize", () => {
    resize();
    if (motionPreference.matches) draw(0);
  }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  const handleMotionChange = () => {
    stop();
    if (motionPreference.matches) {
      pointer.active = false;
      pointer.strength = 0;
    }
    start();
  };
  if (motionPreference.addEventListener) {
    motionPreference.addEventListener("change", handleMotionChange);
  } else if (motionPreference.addListener) {
    motionPreference.addListener(handleMotionChange);
  }

  resize();
  start();
})();
