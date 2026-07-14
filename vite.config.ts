import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.GITHUB_ACTIONS && repository ? `/${repository}/` : './';
const appVersion = process.env.npm_package_version ?? '0.1.0';
const buildRevision = process.env.GITHUB_SHA?.slice(0, 12) ?? 'development';

export default defineConfig({
  plugins: [react()],
  base,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_REVISION__: JSON.stringify(buildRevision),
  },
});
