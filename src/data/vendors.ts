// A vendor registry that knows what each vendor actually sells. The old
// affiliate provider returned every vendor for every query — which is why
// "who has fruits" surfaced Oraimo, a brand that sells power banks and earbuds
// and nothing edible. Category tags fix that: a query only reaches vendors
// whose categories intersect the query's category.

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
  | "groceries"
  | "food"
  | "general";

export interface Vendor {
  id: string;
  name: string;
  /** Categories this vendor genuinely stocks. A marketplace uses "general". */
  categories: VendorCategory[];
  /** Build a search URL for a query on this vendor. */
  searchUrl: (query: string) => string;
  /** Config key holding this vendor's affiliate tag, if any. */
  tagConfig?: "JUMIA_AFFILIATE_TAG" | "ORAIMO_AFFILIATE_TAG";
}

const enc = (q: string) => encodeURIComponent(q.trim());

export const VENDORS: Vendor[] = [
  {
    id: "jumia",
    name: "Jumia",
    // A full marketplace: it stocks nearly everything, groceries included.
    categories: [
      "general",
      "electronics",
      "phones",
      "computing",
      "fashion",
      "home",
      "beauty",
      "groceries",
      "accessories",
    ],
    searchUrl: (q) => `https://www.jumia.com.ng/catalog/?q=${enc(q)}`,
    tagConfig: "JUMIA_AFFILIATE_TAG",
  },
  {
    id: "oraimo",
    name: "Oraimo",
    // A single brand: power, audio, and phone accessories only. Never food.
    categories: ["electronics", "audio", "power", "accessories"],
    searchUrl: (q) => `https://ng.oraimo.com/catalogsearch/result/?q=${enc(q)}`,
    tagConfig: "ORAIMO_AFFILIATE_TAG",
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

/** Vendors that can plausibly sell this query. Falls back to marketplaces
 *  (vendors tagged "general") when the category is unknown, so we never return
 *  an empty list — but we never return a vendor that can't stock the category. */
export function vendorsFor(query: string): Vendor[] {
  const cats = categorize(query);
  if (cats.length === 0) {
    return VENDORS.filter((v) => v.categories.includes("general"));
  }
  const matched = VENDORS.filter((v) =>
    v.categories.some((c) => cats.includes(c)),
  );
  return matched.length > 0
    ? matched
    : VENDORS.filter((v) => v.categories.includes("general"));
}

/** True when this query is food/groceries — the caller may prefer a delivery
 *  vendor over a shopping marketplace. */
export function isEdible(query: string): boolean {
  const cats = categorize(query);
  return cats.includes("food") || cats.includes("groceries");
}
