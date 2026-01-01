// A just-approved agent still needs to poll the approval and start Chromium.
// Wait for that transition without leaving an initial offline snapshot on screen.
export function createAgentStatusWatcher({ load, onStatus, onError, onTimeout = () => {}, visible = () => true, now = Date.now, schedule = setTimeout, cancel = clearTimeout, interval = 1500, duration = 120000 }) {
  let timer; let generation = 0;
  function stop() { generation++; if (timer !== undefined) cancel(timer); timer = undefined; }
  async function start() {
    stop(); const owner = generation; const deadline = now() + duration;
    async function tick() {
      timer = undefined;
      if (owner !== generation || !visible()) return;
      let data;
      try { data = await load(); }
      catch (error) { if (owner === generation && visible()) onError(error); return; }
      if (owner !== generation || !visible()) return;
      onStatus(data);
      if (data.configured === true && data.online !== true && !data.demo) {
        if (now() < deadline) timer = schedule(() => { void tick(); }, interval);
        else onTimeout();
      }
    }
    await tick();
  }
  return { start, stop };
}
