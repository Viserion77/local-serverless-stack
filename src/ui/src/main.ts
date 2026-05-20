import { createApp } from 'vue';
import TreeUI from '@treeui/vue';
import App from './App.vue';
import { router } from './router';
import '@treeui/vue/style.css';
import './style.css';

document.documentElement.setAttribute('data-tree-theme', 'dark');

createApp(App).use(TreeUI).use(router).mount('#app');
