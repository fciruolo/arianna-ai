import { createApp } from 'vue';

import App from './App.vue';
import BrowserPage from './components/BrowserPage.vue';
import { browserConversationFromPath } from './lib/route.ts';
import './style.css';

// The screen of Arianna's browser in a tab of its own (D-264, passo 4): that page alone, without the chat.
const browserConversation = browserConversationFromPath(window.location.pathname);
if (browserConversation !== undefined) createApp(BrowserPage, { conversationId: browserConversation }).mount('#app');
else createApp(App).mount('#app');
