interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface JetsonCredentials {
  accessToken: string;
  viewerToken: string;
}

const EMPTY_CREDENTIALS: JetsonCredentials = { accessToken: "", viewerToken: "" };

export class JetsonCredentialStore {
  private readonly storage: SessionStorageLike | null;
  private readonly key: string;
  private fallback: JetsonCredentials = { ...EMPTY_CREDENTIALS };

  constructor(storage: SessionStorageLike | null, key = "wardy-jetson-session-v1") {
    this.storage = storage;
    this.key = key;
  }

  get(): JetsonCredentials {
    try {
      const stored = this.storage?.getItem(this.key);
      if (!stored) return { ...this.fallback };
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object") return { ...EMPTY_CREDENTIALS };
      const credentials = parsed as Record<string, unknown>;
      if (typeof credentials.accessToken !== "string" || typeof credentials.viewerToken !== "string") {
        return { ...EMPTY_CREDENTIALS };
      }
      return { accessToken: credentials.accessToken, viewerToken: credentials.viewerToken };
    } catch {
      return { ...this.fallback };
    }
  }

  set(accessToken: string, viewerToken: string): JetsonCredentials {
    const credentials = { accessToken: String(accessToken ?? ""), viewerToken: String(viewerToken ?? "") };
    this.fallback = { ...credentials };
    try { this.storage?.setItem(this.key, JSON.stringify(credentials)); } catch { /* Memory fallback remains available. */ }
    return { ...credentials };
  }

  clear(): void {
    this.fallback = { ...EMPTY_CREDENTIALS };
    try { this.storage?.removeItem(this.key); } catch { /* Memory fallback is already cleared. */ }
  }
}
