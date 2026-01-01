// Local assets supplied by the owner. The widget's default duck pair is Ya1/Ya2.
// Preserve its 0.88 Y / 1.05 X squish and 40 ms release-audio overlap.
export function initFish() {
  const button = document.getElementById('fish-button');
  const toggle = document.getElementById('sound-toggle');
  if (!button || !toggle) return;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let context, buffers, pressing = false, muted = false, generation = 0, sound, motion, idleTimer;
  const sources = new Set();
  const bytes = Promise.all(['/assets/Ya1.mp3', '/assets/Ya2.mp3'].map(async (url) => {
    const response = await fetch(url); if (!response.ok) throw new Error('Audio unavailable'); return response.arrayBuffer();
  })).catch(() => null);
  function quiet() {
    generation++; clearTimeout(idleTimer);
    for (const source of sources) { try { source.stop(); } catch {} } sources.clear();
    context?.suspend().catch(() => {});
  }
  function scheduleSleep() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!pressing && !sources.size) context?.suspend().catch(() => {}); }, 1500); }
  function play(buffer, when) {
    const source = context.createBufferSource(); const gain = context.createGain();
    source.buffer = buffer; gain.gain.value = 0.65;
    source.connect(gain); gain.connect(context.destination); sources.add(source);
    source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); scheduleSleep(); };
    source.start(when); return when + buffer.duration;
  }
  function beginSound() {
    if (muted) return Promise.resolve(null);
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return Promise.resolve(null);
    context ||= new Audio();
    const resume = context.resume(); // User gesture, never autoplay on page load.
    const id = ++generation;
    for (const source of sources) { try { source.stop(); } catch {} } sources.clear();
    buffers ||= bytes.then((files) => files && Promise.all(files.map((data) => context.decodeAudioData(data.slice(0)))));
    return Promise.all([resume, buffers]).then(([, decoded]) => {
      if (!decoded || muted || id !== generation || document.hidden) return null;
      return { id, release: decoded[1], end: play(decoded[0], context.currentTime) };
    }).catch(() => null);
  }
  function down() {
    if (pressing) return;
    pressing = true; motion?.cancel();
    if (!reducedMotion.matches) motion = button.animate([{ transform: 'scale(1)' }, { transform: 'scaleX(1.05) scaleY(.88)' }], { duration: 90, fill: 'forwards', easing: 'cubic-bezier(.2,0,0,1)' });
    sound = beginSound();
  }
  function up() {
    if (!pressing) return;
    pressing = false; motion?.cancel();
    if (!reducedMotion.matches) motion = button.animate([{ transform: 'scaleX(1.05) scaleY(.88)' }, { transform: 'scaleX(.98) scaleY(1.04)', offset: .5 }, { transform: 'scale(1)' }], { duration: 360, easing: 'cubic-bezier(.2,0,0,1)' });
    sound?.then((value) => { if (value && value.id === generation && !muted && !document.hidden) play(value.release, Math.max(context.currentTime, value.end - .04)); });
  }
  function cancel() { pressing = false; motion?.cancel(); quiet(); }
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    button.setPointerCapture(event.pointerId); down();
  });
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', cancel);
  button.addEventListener('lostpointercapture', () => { if (pressing) cancel(); });
  button.addEventListener('keydown', (event) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat) down(); } });
  button.addEventListener('keyup', (event) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); up(); } });
  button.addEventListener('click', (event) => { if (event.detail === 0 && !pressing) { down(); setTimeout(up, 90); } });
  button.addEventListener('blur', () => { if (pressing) cancel(); });
  toggle.addEventListener('click', () => {
    muted = !muted; toggle.setAttribute('aria-pressed', String(muted));
    toggle.setAttribute('aria-label', muted ? '开启音效' : '静音'); toggle.title = muted ? '开启音效' : '静音';
    document.getElementById('fish-status').textContent = muted ? '音效已关闭' : '音效已开启';
    if (muted) quiet();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', cancel);
}
