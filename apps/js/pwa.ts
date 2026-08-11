import serviceWorkerUrl from "./service-worker.ts?worker&url";

/** Registers the local Wardy application shell for installable offline startup. */
export async function registerWardyServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register(serviceWorkerUrl, { type: "module" });
  } catch (error) {
    console.warn("Wardy service worker registration failed", error);
    return null;
  }
}
