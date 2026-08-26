import { io } from 'socket.io-client';

// Em produção (Netlify), conecta no backend remoto via VITE_API_URL.
// Em dev, conecta na mesma origem (proxy do Vite resolve).
const backendUrl = import.meta.env.VITE_API_URL ?? '';

export const socket = io(backendUrl || undefined!, {
  autoConnect: false,
  withCredentials: true,
});
