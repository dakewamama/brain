import type { AffiliateProvider, AffiliateProduct } from "./types.js";
import { getConfig } from "../core/config.js";
import { VENDORS, vendorsFor, type Vendor } from "../data/vendors.js";

export class SimpleAffiliateProvider implements AffiliateProvider {
  readonly name = "affiliate";
  private tags: Partial<Record<string, string | undefined>>;
  constructor() {
    const cfg = getConfig();
    this.tags = {
      JUMIA_AFFILIATE_TAG: cfg.JUMIA_AFFILIATE_TAG,
      ORAIMO_AFFILIATE_TAG: cfg.ORAIMO_AFFILIATE_TAG,
    };
  }

  // Only vendors that can actually stock the query. "who has fruits" no longer
  // reaches Oraimo, because Oraimo has no groceries category.
  async search(query: string): Promise<AffiliateProduct[]> {
    return vendorsFor(query).map((v) => ({
      title: `Search ${v.name} for "${query}"`,
      url: this.tagUrl(v, v.searchUrl(query)),
      merchant: v.name,
    }));
  }

  private tagUrl(v: Vendor, url: string): string {
    const tag = v.tagConfig ? this.tags[v.tagConfig] : undefined;
    if (!tag) return url;
    const u = new URL(url);
    u.searchParams.set("aff", tag);
    return u.toString();
  }

  // Kept for the AffiliateProvider interface (callers that hand us a finished
  // URL); applies the Jumia tag by default.
  tag(url: string): string {
    const jumia = VENDORS.find((v) => v.id === "jumia");
    return jumia ? this.tagUrl(jumia, url) : url;
  }
}
