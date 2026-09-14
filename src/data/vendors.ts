// A vendor registry that knows what each vendor actually sells and where it
// operates. The old affiliate provider returned every vendor for every query —
// which is why "who has fruits" surfaced Oraimo, a brand that sells power banks
// and earbuds and nothing edible. Category tags fix that: a query only reaches
// vendors whose categories intersect the query's category.
//
// This is a curated set of real Nigerian vendors. It is intentionally NOT a
// thousand fabricated names — dead or wrong URLs would make the product worse.
// The shape is data-driven: a verified bulk dataset (CSV/JSON from a real
// directory) can be mapped into `Vendor[]` and concatenated onto REGISTERED.

export type VendorCategory =
  | "electronics"
  | "audio"
  | "power"
  | "accessories"
  | "phones"
  | "computing"
  | "fashion"
  | "home"
  | "beauty"
  | "health"
  | "pharmacy"
  | "baby"
  | "groceries"
  | "food"
  | "general";

export type VendorKind = "marketplace" | "brand" | "grocery" | "food-delivery" | "pharmacy";

export interface Vendor {
  id: string;
  name: string;
  kind: VendorKind;
  /** Categories this vendor genuinely stocks. A marketplace uses "general". */
  categories: VendorCategory[];
  /** Build a search URL for a query on this vendor. */
  searchUrl: (query: string) => string;
  /** Config key holding this vendor's affiliate tag, if any. */
  tagConfig?: "JUMIA_AFFILIATE_TAG" | "ORAIMO_AFFILIATE_TAG";
  /** Cities/areas served; "nationwide" for online-shipped marketplaces. */
  areas?: string[];
}

const enc = (q: string) => encodeURIComponent(q.trim());

// Real, verifiable Nigerian vendors. Grouped by kind for readability.
export const VENDORS: Vendor[] = [
  // ── Marketplaces (stock nearly everything, ship nationwide) ──────────────
  {
    id: "jumia",
    name: "Jumia",
    kind: "marketplace",
    categories: ["general", "electronics", "phones", "computing", "fashion", "home", "beauty", "health", "baby", "groceries", "accessories"],
    searchUrl: (q) => `https://www.jumia.com.ng/catalog/?q=${enc(q)}`,
    tagConfig: "JUMIA_AFFILIATE_TAG",
    areas: ["nationwide"],
  },
  {
    id: "konga",
    name: "Konga",
    kind: "marketplace",
    categories: ["general", "electronics", "phones", "computing", "fashion", "home", "beauty", "health", "baby", "groceries", "accessories"],
    searchUrl: (q) => `https://www.konga.com/search?search=${enc(q)}`,
    areas: ["nationwide"],
  },
  {
    id: "jiji",
    name: "Jiji",
    kind: "marketplace",
    categories: ["general", "electronics", "phones", "computing", "fashion", "home", "accessories"],
    searchUrl: (q) => `https://jiji.ng/search?query=${enc(q)}`,
    areas: ["nationwide"],
  },
  {
    id: "temu-ng",
    name: "Temu",
    kind: "marketplace",
    categories: ["general", "fashion", "home", "accessories", "beauty"],
    searchUrl: (q) => `https://www.temu.com/search_result.html?search_key=${enc(q)}`,
    areas: ["nationwide"],
  },

  // ── Electronics / gadget specialists ─────────────────────────────────────
  {
    id: "oraimo",
    name: "Oraimo",
    kind: "brand",
    categories: ["electronics", "audio", "power", "accessories"],
    searchUrl: (q) => `https://ng.oraimo.com/catalogsearch/result/?q=${enc(q)}`,
    tagConfig: "ORAIMO_AFFILIATE_TAG",
    areas: ["nationwide"],
  },
  {
    id: "slot",
    name: "Slot",
    kind: "brand",
    categories: ["electronics", "phones", "computing", "accessories"],
    searchUrl: (q) => `https://slot.ng/?s=${enc(q)}&post_type=product`,
    areas: ["nationwide"],
  },
  {
    id: "pointek",
    name: "Pointek",
    kind: "brand",
    categories: ["electronics", "phones", "computing", "accessories"],
    searchUrl: (q) => `https://pointek.com.ng/?s=${enc(q)}&post_type=product`,
    areas: ["nationwide"],
  },

  // ── Groceries ────────────────────────────────────────────────────────────
  {
    id: "pricepally",
    name: "PricePally",
    kind: "grocery",
    categories: ["groceries", "food"],
    searchUrl: (q) => `https://www.pricepally.com/search?q=${enc(q)}`,
    areas: ["lagos", "abuja"],
  },
  {
    id: "supermart",
    name: "Supermart",
    kind: "grocery",
    categories: ["groceries", "home", "baby"],
    searchUrl: (q) => `https://www.supermart.ng/catalogsearch/result/?q=${enc(q)}`,
    areas: ["lagos"],
  },

  // ── Food delivery ────────────────────────────────────────────────────────
  {
    id: "chowdeck",
    name: "Chowdeck",
    kind: "food-delivery",
    categories: ["food", "groceries"],
    searchUrl: () => `https://chowdeck.com/`,
    areas: ["lagos", "abuja", "port harcourt", "ibadan"],
  },
  {
    id: "glovo",
    name: "Glovo",
    kind: "food-delivery",
    categories: ["food", "groceries", "pharmacy"],
    searchUrl: () => `https://glovoapp.com/ng/en/`,
    areas: ["lagos", "abuja", "port harcourt"],
  },
  {
    id: "boltfood",
    name: "Bolt Food",
    kind: "food-delivery",
    categories: ["food"],
    searchUrl: () => `https://food.bolt.eu/`,
    areas: ["lagos", "abuja"],
  },

  // ── Pharmacy / health ────────────────────────────────────────────────────
  {
    id: "healthplus",
    name: "HealthPlus",
    kind: "pharmacy",
    categories: ["pharmacy", "health", "beauty", "baby"],
    searchUrl: (q) => `https://www.healthplus.ng/catalogsearch/result/?q=${enc(q)}`,
    areas: ["nationwide"],
  },
  {
    id: "medplus",
    name: "MedPlus",
    kind: "pharmacy",
    categories: ["pharmacy", "health", "beauty"],
    searchUrl: (q) => `https://www.medplusnig.com/?s=${enc(q)}&post_type=product`,
    areas: ["nationwide"],
  },
];

// Keyword → category. Deliberately small and explicit; the model-driven path
// classifies richer, but this keeps the deterministic fallback from mapping
// food to an electronics brand.
const CATEGORY_KEYWORDS: Record<VendorCategory, string[]> = {
  power: ["powerbank", "power bank", "charger", "battery", "power station", "inverter"],
  audio: ["earbuds", "earphone", "earphones", "headphone", "headphones", "speaker", "airpods", "soundbar"],
  phones: ["phone", "iphone", "android", "smartphone", "tecno", "infinix", "samsung"],
  computing: ["laptop", "computer", "keyboard", "mouse", "monitor", "ssd", "hard drive"],
  electronics: ["tv", "television", "fridge", "freezer", "fan", "gadget", "electronics", "camera"],
  accessories: ["case", "cable", "adapter", "screen protector", "watch strap", "smartwatch"],
  fashion: ["shoe", "shoes", "shirt", "dress", "trouser", "bag", "sneaker", "cloth", "clothes", "wear"],
  beauty: ["cream", "makeup", "perfume", "lipstick", "skincare", "cosmetic", "lotion"],
  health: ["vitamin", "supplement", "first aid", "thermometer", "bandage"],
  pharmacy: ["drug", "medicine", "paracetamol", "malaria", "antibiotic", "prescription", "pharmacy"],
  baby: ["diaper", "diapers", "baby", "pampers", "formula", "wipes"],
  home: ["mattress", "pillow", "cookware", "pot", "furniture", "bedsheet", "kettle", "blender"],
  groceries: [
    "fruit", "fruits", "vegetable", "vegetables", "grocery", "groceries",
    "rice", "beans", "milk", "bread", "egg", "eggs", "provision", "provisions",
    "sugar", "salt", "oil", "tomato", "tomatoes", "onion", "onions",
  ],
  food: ["food", "meal", "lunch", "dinner", "jollof", "suya", "pizza", "chicken", "shawarma"],
  general: [],
};

/** Best-effort category tags for a query. Empty means "unknown → general". */
export function categorize(query: string): VendorCategory[] {
  const t = query.toLowerCase();
  const hits: VendorCategory[] = [];
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS) as [VendorCategory, string[]][]) {
    if (words.some((w) => t.includes(w))) hits.push(cat);
  }
  return hits;
}

/** Vendors that can plausibly sell this query. Falls back to marketplaces when
 *  the category is unknown, so we never return an empty list — but we never
 *  return a vendor that can't stock the category. */
export function vendorsFor(query: string): Vendor[] {
  const cats = categorize(query);
  if (cats.length === 0) {
    return VENDORS.filter((v) => v.kind === "marketplace");
  }
  const matched = VENDORS.filter((v) => v.categories.some((c) => cats.includes(c)));
  return matched.length > 0
    ? matched
    : VENDORS.filter((v) => v.kind === "marketplace");
}

/** True when this query is food/groceries — the caller may prefer a delivery
 *  vendor over a shopping marketplace. */
export function isEdible(query: string): boolean {
  const cats = categorize(query);
  return cats.includes("food") || cats.includes("groceries");
}
