import type { GeoLocation } from "../core/types.js";

export interface CatalogItem {
  name: string;
  priceKobo: number;
  inStock: boolean;
}

export interface Vendor {
  id: string;
  name: string;
  location: GeoLocation;
  items: CatalogItem[];
}
const VENDORS: Vendor[] = [
  {
    id: "nadia",
    name: "Nadia's Kitchen",
    location: {
      latitude: 6.4478,
      longitude: 3.4723,
      address: "Lekki Phase 1, Lagos",
      label: "Nadia's Kitchen",
    },
    items: [
      { name: "chicken wings", priceKobo: 100000, inStock: true },
      { name: "jollof rice", priceKobo: 250000, inStock: true },
      { name: "fried rice", priceKobo: 250000, inStock: false },
      { name: "shawarma", priceKobo: 350000, inStock: true },
    ],
  },
  {
    id: "mamaput",
    name: "Mama Put Express",
    location: {
      latitude: 6.4531,
      longitude: 3.3958,
      address: "Yaba, Lagos",
      label: "Mama Put Express",
    },
    items: [
      { name: "amala", priceKobo: 200000, inStock: true },
      { name: "egusi soup", priceKobo: 180000, inStock: true },
      { name: "pounded yam", priceKobo: 220000, inStock: true },
    ],
  },
];

export function findVendor(query: string): Vendor | null {
  const q = query.toLowerCase();
  return (
    VENDORS.find((v) => q.includes(v.id) || q.includes(v.name.toLowerCase())) ??
    null
  );
}

export function findItem(vendor: Vendor, query: string): CatalogItem | null {
  const q = query.toLowerCase();
  const matches = vendor.items
    .filter((it) => q.includes(it.name))
    .sort((a, b) => b.name.length - a.name.length);
  return matches[0] ?? null;
}

export function searchItemEverywhere(query: string): Array<{
  vendor: Vendor;
  item: CatalogItem;
}> {
  const q = query.toLowerCase();
  const results: Array<{
    vendor: Vendor;
    item: CatalogItem;
  }> = [];
  for (const vendor of VENDORS) {
    for (const item of vendor.items) {
      if (q.includes(item.name)) results.push({ vendor, item });
    }
  }
  return results;
}

export function listVendors(): Vendor[] {
  return VENDORS;
}
