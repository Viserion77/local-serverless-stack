<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../services/api';

interface Service {
  name: string;
  status: 'registered' | 'running' | 'stopped';
  root: string;
  lastUpdated: number;
  resourcesCount?: number;
}

const services = ref<Service[]>([]);
const loading = ref(true);
const registering = ref(false);
const newServicePath = ref('');
const logsService = ref<string | null>(null);
const logs = ref<string[]>([]);
const logsStatus = ref<'running' | 'stopped' | 'failed'>('stopped');
const logTimer = ref<number | null>(null);
const starting = ref<Record<string, boolean>>({});
const stopping = ref<Record<string, boolean>>({});

async function loadServices() {
  try {
    services.value = await api.listServices();
  } catch (error) {
    console.error('Failed to load services:', error);
  } finally {
    loading.value = false;
  }
}

async function startService(name: string) {
  if (starting.value[name]) return;
  starting.value = { ...starting.value, [name]: true };
  try {
    await api.startService(name);
    await loadServices();
  } catch (error: any) {
    alert(`Failed to start service: ${error.message}`);
  } finally {
    starting.value = { ...starting.value, [name]: false };
  }
}

async function stopService(name: string) {
  if (stopping.value[name]) return;
  stopping.value = { ...stopping.value, [name]: true };
  try {
    await api.stopService(name);
    await loadServices();
  } catch (error: any) {
    alert(`Failed to stop service: ${error.message}`);
  } finally {
    stopping.value = { ...stopping.value, [name]: false };
  }
}

async function fetchLogs(name: string) {
  try {
    const data = await api.getServiceLogs(name);
    logs.value = data.logs || [];
    logsStatus.value = data.status || 'stopped';
  } catch (error) {
    console.error('Failed to fetch logs:', error);
  }
}

function openLogs(name: string) {
  logsService.value = name;
  fetchLogs(name);
  if (logTimer.value) window.clearInterval(logTimer.value);
  logTimer.value = window.setInterval(() => fetchLogs(name), 2000);
}

function closeLogs() {
  logsService.value = null;
  logs.value = [];
  if (logTimer.value) window.clearInterval(logTimer.value);
  logTimer.value = null;
}

async function registerService() {
  if (!newServicePath.value.trim()) return;

  registering.value = true;
  try {
    await api.registerService(newServicePath.value);
    newServicePath.value = '';
    await loadServices();
  } catch (error: any) {
    alert(`Failed to register service: ${error.message}`);
  } finally {
    registering.value = false;
  }
}

async function deleteService(name: string) {
  if (!confirm(`Delete service "${name}"?`)) return;

  try {
    await api.deleteService(name);
    await loadServices();
  } catch (error: any) {
    alert(`Failed to delete service: ${error.message}`);
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function getStatusBadgeClass(status: string): string {
  switch (status) {
    case 'running':
      return 'badge-success';
    case 'registered':
      return 'badge-warning';
    default:
      return 'badge-danger';
  }
}

onMounted(() => {
  loadServices();
  setInterval(loadServices, 10000);
});
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h2 class="card-title">
        Microservices
      </h2>
      <div style="display: flex; gap: 0.5rem; align-items: center">
        <input
          v-model="newServicePath"
          type="text"
          placeholder="/path/to/microservice"
          style="
            padding: 0.5rem;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 0.375rem;
            color: var(--text);
            width: 300px;
          "
          @keyup.enter="registerService"
        >
        <button
          class="btn btn-primary"
          :disabled="registering || !newServicePath.trim()"
          @click="registerService"
        >
          {{ registering ? 'Registering...' : 'Register' }}
        </button>
      </div>
    </div>

    <div
      v-if="loading"
      class="loading"
    >
      Loading services...
    </div>

    <div
      v-else-if="services.length === 0"
      class="empty-state"
    >
      No services registered yet. Register your first microservice above.
    </div>

    <table
      v-else
      class="table"
    >
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Path</th>
          <th>Resources</th>
          <th>Last Updated</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="service in services"
          :key="service.name"
        >
          <td>
            <strong>{{ service.name }}</strong>
          </td>
          <td>
            <span
              class="badge"
              :class="getStatusBadgeClass(service.status)"
            >
              {{ service.status }}
            </span>
          </td>
          <td style="font-family: monospace; font-size: 0.875rem">
            {{ service.root }}
          </td>
          <td>{{ service.resourcesCount || 0 }}</td>
          <td>{{ formatDate(service.lastUpdated) }}</td>
          <td>
            <div class="actions">
              <button
                class="btn btn-sm"
                :disabled="service.status === 'running' || starting[service.name]"
                @click="startService(service.name)"
              >
                {{ starting[service.name] ? 'Starting...' : 'Start' }}
              </button>
              <button
                class="btn btn-sm btn-secondary"
                :disabled="service.status !== 'running' || stopping[service.name]"
                @click="stopService(service.name)"
              >
                {{ stopping[service.name] ? 'Stopping...' : 'Stop' }}
              </button>
              <button
                class="btn btn-sm"
                @click="openLogs(service.name)"
              >
                Logs
              </button>
              <button
                class="btn btn-sm btn-danger"
                @click="deleteService(service.name)"
              >
                Delete
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <div
      v-if="logsService"
      class="modal"
    >
      <div class="modal-content">
        <div class="modal-header">
          <h3>Logs — {{ logsService }} ({{ logsStatus }})</h3>
          <button
            class="btn btn-sm"
            @click="closeLogs"
          >
            Close
          </button>
        </div>
        <pre class="logs">{{ logs.join('\n') }}
        </pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.modal-content {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  width: 720px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.logs {
  flex: 1;
  padding: 1rem;
  margin: 0;
  background: #0b0c10;
  color: #d1d5db;
  font-family: Menlo, Consolas, Monaco, monospace;
  font-size: 0.85rem;
  overflow: auto;
  min-height: 300px;
  white-space: pre-wrap;
}

.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
