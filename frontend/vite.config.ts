import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    minify: 'esbuild',
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        // Split big vendor libs so the app shell loads faster and the heavy
        // map / chart deps are cached separately.
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'leaflet-vendor': ['leaflet', 'react-leaflet'],
          'recharts-vendor': ['recharts'],
          'icons-vendor': ['lucide-react'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'leaflet', 'react-leaflet', 'recharts', 'lucide-react'],
  },
  server: {
    // dev-only: warm up the heavy modules so first navigation is faster
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/VesselMap.tsx',
        './src/components/ZoneTrafficChart.tsx',
      ],
    },
  },
})
