import { createApp } from 'vue';
import TreeUI from '@treeui/vue';
import App from './App.vue';
import { router } from './router';
import '@treeui/vue/style.css';
import './style.css';
import { getStoredTheme, applyTheme } from './services/branding';

// The user's stored choice applies immediately (no flash); otherwise start
// dark and let loadBranding() switch to the configured default theme.
applyTheme(getStoredTheme() ?? 'dark');

createApp(App).use(TreeUI).use(router).mount('#app');
