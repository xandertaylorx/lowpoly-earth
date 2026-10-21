import { defineConfig } from 'vite';

// relative base so the build works from any path (GitHub Pages project sites live under /<repo>/)
export default defineConfig({ base: './' });
