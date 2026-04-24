/**
 * Service-location picker + URL resolver.
 *
 * Used when a user is configuring a service that runs somewhere on the same
 * or adjacent machine (Ollama, LM Studio, llama.cpp, SearXNG, etc.). Instead
 * of asking "type a URL" — which means users need to know about
 * `host.docker.internal`, WSL networking, and port conventions — we ask
 * "where is the service?" and compute the URL ourselves.
 *
 * Deliberate separation of concerns:
 *   - {@link ServiceLocation} — the data model (discriminated union)
 *   - {@link resolveServiceUrl} — the pure string builder
 *   - {@link pickServiceLocation} — the UI surface (quickPick + inputBox)
 *
 * The UI-free pieces are usable from tests and from alternate UIs. The
 * picker function is currently a VS Code quickPick; swapping to a webview
 * popup later would only replace this one function.
 *
 * See [docs/plans/web-search-providers.md](../../docs/plans/web-search-providers.md).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

// ── Data model ──

export type ServiceLocation =
  /** Native install OR Docker with `-p PORT:PORT`, on the machine where the
   *  extension host runs. `localhost` reaches it. Covers 80%+ of real setups. */
  | { kind: 'same-host'; port: number; path?: string }
  /** VS Code Remote-WSL, service is a Windows-native app. Extension is in
   *  WSL's network; service is in Windows's network. `host.docker.internal`
   *  is the canonical alias. */
  | { kind: 'wsl-to-windows'; port: number; path?: string }
  /** Dedicated machine on the user's LAN (homelab, NAS, AI box). Hostname
   *  is user-provided. */
  | { kind: 'lan'; host: string; port: number; path?: string }
  /** Escape hatch — user types the full URL. We don't touch it. */
  | { kind: 'custom'; url: string };

/**
 * Pure function. Turns a {@link ServiceLocation} into an absolute URL.
 * No side effects; safe to call anywhere (including tests).
 */
export function resolveServiceUrl(loc: ServiceLocation): string {
  switch (loc.kind) {
    case 'same-host':
      return `http://localhost:${loc.port}${loc.path ?? ''}`;
    case 'wsl-to-windows':
      return `http://host.docker.internal:${loc.port}${loc.path ?? ''}`;
    case 'lan': {
      // Hostname may be user-typed — strip scheme if they included it,
      // so we don't build `http://http://foo:8080`.
      const bare = loc.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return `http://${bare}:${loc.port}${loc.path ?? ''}`;
    }
    case 'custom':
      return loc.url;
  }
}

// ── Environment detection ──

/**
 * True when the extension host is running inside WSL2. Signals that the
 * "Windows host" location option is relevant and worth showing in the
 * picker — outside WSL it would just be confusing noise.
 *
 * Uses `/proc/version` rather than `uname` or `process.platform` because
 * those identify a WSL kernel as "Linux" and don't distinguish from a
 * native Linux install.
 */
export function isWSL(): boolean {
  try {
    const v = fs.readFileSync('/proc/version', 'utf-8');
    return /microsoft/i.test(v);
  } catch {
    return false;
  }
}

// ── UI: picker wizard ──

export interface PickServiceLocationOptions {
  /** Human-readable service name shown in quickPick titles (e.g. "Ollama",
   *  "SearXNG"). */
  serviceName: string;
  /** Default port prefilled in the port prompt. */
  defaultPort: number;
  /** Optional URL path suffix baked into structured kinds (e.g. "/v1" for
   *  OpenAI-compatible LLM endpoints). Custom-URL kind doesn't use this —
   *  the user types the full path themselves. */
  pathSuffix?: string;
}

/** QuickPick item carrying the ServiceLocation kind. Named `locationKind`
 *  to avoid colliding with anything QuickPickItem might introduce. */
interface LocationPickItem extends vscode.QuickPickItem {
  locationKind: 'same-host' | 'wsl-to-windows' | 'lan' | 'custom';
}

/**
 * Run the quickPick + inputBox sequence for a single service endpoint.
 * Returns the chosen `ServiceLocation`, or `undefined` if the user cancels
 * at any step.
 */
export async function pickServiceLocation(
  options: PickServiceLocationOptions
): Promise<ServiceLocation | undefined> {
  const { serviceName, defaultPort, pathSuffix } = options;
  const inWSL = isWSL();

  // Order: most common → least common. "Same machine" first because it's
  // right for the majority of users (native install or Docker on the same
  // machine). "Custom URL" last as escape hatch.
  const items: LocationPickItem[] = [
    {
      label: 'Same machine',
      description: 'localhost',
      detail: 'Native install or Docker with a published port, on this machine.',
      locationKind: 'same-host'
    }
  ];
  if (inWSL) {
    items.push({
      label: 'Windows host',
      description: 'host.docker.internal',
      detail: 'Service runs on Windows (e.g. LM Studio, Ollama.exe); VS Code is attached to WSL.',
      locationKind: 'wsl-to-windows'
    });
  }
  items.push(
    {
      label: 'Another machine',
      description: 'hostname or LAN IP',
      detail: 'Service runs on a different machine you can reach over the network.',
      locationKind: 'lan'
    },
    {
      label: 'Custom URL',
      description: 'full URL',
      detail: 'Type the full URL yourself (scheme, host, port, path).',
      locationKind: 'custom'
    }
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: `Where is ${serviceName} running?`,
    placeHolder: 'Pick a location',
    ignoreFocusOut: true
  });
  if (!picked) return undefined;

  switch (picked.locationKind) {
    case 'same-host':
    case 'wsl-to-windows': {
      const port = await promptForPort(serviceName, defaultPort);
      if (port === undefined) return undefined;
      return { kind: picked.locationKind, port, path: pathSuffix };
    }
    case 'lan': {
      const host = await vscode.window.showInputBox({
        title: `${serviceName}: hostname or LAN IP`,
        prompt: 'Hostname (e.g. ai-box.local) or IP (e.g. 192.168.1.42)',
        placeHolder: 'ai-box.local',
        ignoreFocusOut: true,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) return 'Required';
          if (/\s/.test(trimmed)) return 'Hostname cannot contain spaces';
          return null;
        }
      });
      if (host === undefined) return undefined;
      const port = await promptForPort(serviceName, defaultPort);
      if (port === undefined) return undefined;
      return { kind: 'lan', host: host.trim(), port, path: pathSuffix };
    }
    case 'custom': {
      const url = await vscode.window.showInputBox({
        title: `${serviceName}: custom URL`,
        prompt: 'Full URL (scheme + host + port + path)',
        placeHolder: pathSuffix
          ? `http://localhost:${defaultPort}${pathSuffix}`
          : `http://localhost:${defaultPort}`,
        ignoreFocusOut: true,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) return 'Required';
          try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              return 'Must be http:// or https://';
            }
            return null;
          } catch {
            return 'Not a valid URL';
          }
        }
      });
      if (url === undefined) return undefined;
      return { kind: 'custom', url: url.trim() };
    }
  }
}

async function promptForPort(serviceName: string, defaultPort: number): Promise<number | undefined> {
  const raw = await vscode.window.showInputBox({
    title: `${serviceName}: port`,
    prompt: 'TCP port the service is listening on',
    value: String(defaultPort),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return 'Port must be an integer between 1 and 65535';
      }
      return null;
    }
  });
  if (raw === undefined) return undefined;
  return Number(raw.trim());
}
