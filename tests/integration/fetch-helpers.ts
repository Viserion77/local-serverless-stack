/**
 * Helper functions for API requests using fetch
 */

export interface ApiResponse<T = any> {
  status: number;
  data: T;
}

export class FetchError extends Error {
  constructor(public status: number, message: string, public data?: any) {
    super(message);
    this.name = 'FetchError';
  }
}

export async function apiRequest<T = any>(
  url: string,
  options?: RequestInit,
): Promise<ApiResponse<T>> {
  const response = await fetch(url, options);
  
  let data: any;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    throw new FetchError(response.status, `HTTP ${response.status}`, data);
  }

  return { status: response.status, data };
}

export async function get<T = any>(url: string): Promise<ApiResponse<T>> {
  return apiRequest(url);
}

export async function post<T = any>(url: string, body: any): Promise<ApiResponse<T>> {
  return apiRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function del<T = any>(url: string): Promise<ApiResponse<T>> {
  return apiRequest(url, { method: 'DELETE' });
}

export async function put<T = any>(url: string, body: any): Promise<ApiResponse<T>> {
  return apiRequest(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
