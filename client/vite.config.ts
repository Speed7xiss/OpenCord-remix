import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Em produção, VITE_API_URL aponta para o backend hospedado separadamente
  // Ex: https://meu-backend.railway.app
  const backendUrl = env.VITE_API_URL || 'http://127.0.0.1:4000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': backendUrl,
        '/uploads': backendUrl,
        '/socket.io': { target: backendUrl, ws: true },
      },
    },
  };
});
