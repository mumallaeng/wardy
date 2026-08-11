/** Registers the local Wardy application shell for installable offline startup. */
export async function registerWardyServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (import.meta.env.DEV || !("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
      type: "module",
    });
  } catch (error) {
    console.warn("Wardy service worker registration failed", error);
    return null;
  }
}
