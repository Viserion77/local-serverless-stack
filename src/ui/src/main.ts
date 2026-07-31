import { createApp } from 'vue';
import TreeUI from '@treeui/vue';
import App from './App.vue';
import { router } from './router';
import '@treeui/vue/style.css';
import './style.css';
import { getStoredTheme, applyTheme } from './services/branding';
import { registerAwsIcons } from './icons/aws';

// The user's stored choice applies immediately (no flash); otherwise start
// dark and let loadBranding() switch to the configured default theme.
applyTheme(getStoredTheme() ?? 'dark');

// The official AWS service marks are application-supplied icons in TreeUI's
// registry (see ./icons/aws/NOTICE.md). Registering before createApp() means
// the first paint already resolves every `aws-*` name — the registry is
// reactive, but a later call would warn once per icon rendered before it.
registerAwsIcons();

createApp(App).use(TreeUI).use(router).mount('#app');
