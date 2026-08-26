export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// Em produção (Netlify), aponta para o backend hospedado separadamente.
// Em dev, fica vazio e o proxy do Vite resolve.
const BASE_URL = import.meta.env.VITE_API_URL ?? '';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    let message = `HTTP error ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.error === 'string') message = body.error;
    } catch {
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
