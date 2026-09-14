// Live product browsing via Serper's Google Shopping endpoint. This is the
// difference between "here's a link, go look yourself" and actually finding the
// item: it returns real products with title, price, image and a direct link.
//
// It is env-gated (SERPER_API_KEY). With no key, browse() returns null and the
// caller falls back to vendor search links — so the bot degrades, never breaks.
// Prices and images come straight from the source; nothing here is invented and
// no model call is made (which also keeps it off the free-tier rate limit).

import type { ProductCard } from "../core/types.js";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("browse");

interface SerperShoppingItem {
  title?: string;
  source?: string;
  link?: string;
  price?: string;
  imageUrl?: string;
  rating?: number;
  ratingCount?: number;
}

export function browseEnabled(): boolean {
  return Boolean(getConfig().SERPER_API_KEY);
}

/** Search real Nigerian shopping results for a query. Returns up to `limit`
 *  products, or null when browsing isn't configured or the call fails. */
export async function browse(
  query: string,
  limit = 8,
  timeoutMs = 8000,
): Promise<ProductCard[] | null> {
  const cfg = getConfig();
  if (!cfg.SERPER_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.SERPER_SHOPPING_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": cfg.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      // gl=ng, hl=en scope results to Nigeria; the query is nudged local too.
      body: JSON.stringify({ q: `${query} price`, gl: "ng", hl: "en", num: limit }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "serper.shopping non-ok");
      return null;
    }
    const data = (await res.json()) as { shopping?: SerperShoppingItem[] };
    const items = data.shopping ?? [];
    const products = items
      .filter((i) => i.title && i.link)
      .slice(0, limit)
      .map<ProductCard>((i) => ({
        title: i.title!.trim(),
        // Only surface a price the source actually returned; never fabricate.
        price: i.price?.trim() || undefined,
        imageUrl: i.imageUrl?.trim() || undefined,
        url: i.link!,
        merchant: i.source?.trim() || "Store",
      }));
    return products.length > 0 ? products : null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "serper.shopping failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
