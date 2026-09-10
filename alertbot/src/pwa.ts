// Progressive Web App assets — make the dashboard installable as a desktop/mobile
// app (Chrome/Edge "Install", or iOS "Add to Home Screen"). Served by server.ts.

export const MANIFEST = JSON.stringify({
  name: "Candela",
  short_name: "Candela",
  start_url: "/",
  display: "standalone",
  background_color: "#000000",
  theme_color: "#000000",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
});

// Minimal service worker: network-first (dashboard is live), cache as offline fallback.
export const SW_JS = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
`;

// The Three Candles brand mark (ascending candlesticks) — white on black, matching
// the app's Vercel-style monochrome design system.
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">` +
  `<rect width="192" height="192" rx="44" fill="#000000"/>` +
  `<rect x="1" y="1" width="190" height="190" rx="43" fill="none" stroke="#262626" stroke-width="2"/>` +
  `<line x1="47.3" y1="84.8" x2="47.3" y2="167.3" stroke="#ffffff" stroke-width="12"/>` +
  `<rect x="32.3" y="99.8" width="30" height="48.8" rx="7.5" fill="#ffffff"/>` +
  `<line x1="96" y1="54.8" x2="96" y2="144.8" stroke="#ffffff" stroke-width="12"/>` +
  `<rect x="81" y="69.8" width="30" height="52.5" rx="7.5" fill="#ffffff"/>` +
  `<line x1="144.8" y1="21" x2="144.8" y2="114.8" stroke="#ffffff" stroke-width="12"/>` +
  `<rect x="129.8" y="36" width="30" height="60" rx="7.5" fill="#ffffff"/></svg>`;
