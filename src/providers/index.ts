import type { Provider, ProviderRef } from "../core/types.ts";
import { instagram } from "./instagram.ts";
import { youtube } from "./youtube.ts";

// Adding a platform = one file in this folder + one line here.
export const providers: Provider[] = [instagram, youtube];

export function classify(raw: string, list: Provider[]): { provider: Provider; ref: ProviderRef } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  for (const provider of list) {
    const ref = provider.match(url);
    if (ref) return { provider, ref };
  }
  return null;
}
