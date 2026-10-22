import { createApp } from 'vue';

import App from './App.vue';
import BrowserPage from './components/BrowserPage.vue';
import UnpairedPage from './components/UnpairedPage.vue';
import { onRemoteOrigin, registerWorker, remotePaired } from './lib/remote.ts';
import { browserConversationFromPath } from './lib/route.ts';
import './style.css';

async function start(): Promise<void> {
  // From the phone (D-292): the page installs as an app; without pairing, only the notice.
  if (onRemoteOrigin(window.location)) {
    registerWorker().catch(() => undefined);
    if (!(await remotePaired())) {
      createApp(UnpairedPage, { onRetry: () => { window.location.reload(); } }).mount('#app');
      return;
    }
  }
  // The screen of Arianna's browser in a tab of its own (D-264, passo 4): that page alone, without the chat.
  const browserConversation = browserConversationFromPath(window.location.pathname);
  if (browserConversation !== undefined) createApp(BrowserPage, { conversationId: browserConversation }).mount('#app');
  else createApp(App).mount('#app');
}

void start();
