import type { AffiliateProvider, AffiliateProduct } from "./types.js";
import { getConfig } from "../core/config.js";

export class SimpleAffiliateProvider implements AffiliateProvider {
  readonly name = "affiliate";
  private jumiaTag?: string;
  private oraimoTag?: string;
  constructor() {
    const cfg = getConfig();
    this.jumiaTag = cfg.JUMIA_AFFILIATE_TAG;
    this.oraimoTag = cfg.ORAIMO_AFFILIATE_TAG;
  }
  async search(query: string): Promise<AffiliateProduct[]> {
    const q = encodeURIComponent(query.trim());
    const results: AffiliateProduct[] = [];
    results.push({
      title: `Search Jumia for "${query}"`,
      url: this.tag(`https://www.jumia.com.ng/catalog/?q=${q}`),
      merchant: "Jumia",
    });
    results.push({
      title: `Search Oraimo for "${query}"`,
      url: this.tagOraimo(`https://ng.oraimo.com/catalogsearch/result/?q=${q}`),
      merchant: "Oraimo",
    });
    return results;
  }
  tag(url: string): string {
    if (!this.jumiaTag) return url;
    const u = new URL(url);
    u.searchParams.set("aff", this.jumiaTag);
    return u.toString();
  }
  private tagOraimo(url: string): string {
    if (!this.oraimoTag) return url;
    const u = new URL(url);
    u.searchParams.set("aff", this.oraimoTag);
    return u.toString();
  }
}
