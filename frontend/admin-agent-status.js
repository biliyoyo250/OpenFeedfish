// A just-approved agent still needs to poll the approval and start Chromium.
// Wait for that transition without leaving an initial offline snapshot on screen.
export function createAgentStatusWatcher({ load, onStatus, onError, onTimeout = () => {}, keepWaiting = (data) => data.configured === true && data.online !== true && !data.demo, visible = () => true, now = Date.now, schedule = setTimeout, cancel = clearTimeout, interval = 1500, duration = 120000 }) {
  let timer; let generation = 0;
  function stop() { generation++; if (timer !== undefined) cancel(timer); timer = undefined; }
  async function start() {
    stop(); const owner = generation; const deadline = now() + duration;
    async function tick() {
      timer = undefined;
      if (owner !== generation || !visible()) return;
      try {
        const data = await load();
        if (owner !== generation || !visible()) return;
        await onStatus(data);
        if (owner !== generation || !visible()) return;
        if (keepWaiting(data)) {
          if (now() < deadline) timer = schedule(() => { void tick(); }, interval);
          else onTimeout();
        }
      } catch (error) { if (owner === generation && visible()) onError(error); }
    }
    await tick();
  }
  return { start, stop };
}
