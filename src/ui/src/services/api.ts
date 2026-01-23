const API_BASE = import.meta.env.DEV ? 'http://localhost:3100' : '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  // Health
  checkHealth: () => request<{ status: string; localstack: boolean }>('/api/health'),

  // Services
  listServices: () => request<any[]>('/api/services'),
  getService: (name: string) => request<any>(`/api/services/${name}`),
  registerService: (servicePath: string) =>
    request<any>('/api/services/register', {
      method: 'POST',
      body: JSON.stringify({ servicePath }),
    }),
  deleteService: (name: string) =>
    request<any>(`/api/services/${name}`, {
      method: 'DELETE',
    }),
  updateServiceStatus: (name: string, status: string, pid?: number) =>
    request<any>(`/api/services/${name}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, pid }),
    }),

  // Process control
  startService: (name: string, payload?: { stage?: string; cwd?: string; command?: string; args?: string[] }) =>
    request<any>(`/api/services/${name}/start`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    }),
  stopService: (name: string) =>
    request<any>(`/api/services/${name}/stop`, {
      method: 'POST',
    }),
  getServiceLogs: (name: string) => request<any>(`/api/services/${name}/logs`),

  // Resources
  listResources: () => request<{ tables: string[]; queues: string[]; topics: string[] }>('/api/resources'),
};
