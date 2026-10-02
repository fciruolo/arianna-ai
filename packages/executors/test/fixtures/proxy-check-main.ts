// Run with NODE_USE_ENV_PROXY=1 and HTTP_PROXY set: node proxy-check-main.ts <mode> <endpoint url>
//   adapter  a chat and a watchdog health check through @arianna/executors
//   fetch    a plain fetch, to show that the environment does turn the proxy on
// Prints one JSON line with what happened.
import { createLocalModel, Watchdog } from '@arianna/executors';

const [mode, url = ''] = process.argv.slice(2);

if (mode === 'fetch') {
  try {
    // Through the fake proxy it may never answer: only reaching the proxy matters.
    await (await fetch(`${url}/models`, { signal: AbortSignal.timeout(2_000) })).text();
    console.log(JSON.stringify({ ok: true }));
  } catch {
    console.log(JSON.stringify({ ok: false }));
  }
} else {
  const model = createLocalModel({ endpoints: [{ id: 'fake', url, models: { 'local-large': 'fake-large' } }] });
  const result = await model.chat({ model: 'local-large', messages: [{ role: 'user', content: 'hi' }] });
  const watchdog = new Watchdog({ id: 'fake', url });
  await watchdog.start();
  const state = watchdog.state;
  await watchdog.stop();
  console.log(JSON.stringify({ ok: true, text: result.text, state }));
}

// fetch may keep a connection to the proxy open, and with it the process.
process.exit(0);
