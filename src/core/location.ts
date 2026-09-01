import type { InboundMessage, GeoLocation } from "./types.js";

export function extractLocation(msg: InboundMessage): GeoLocation | null {
  const data = msg.data as
    | {
        location?: {
          latitude?: number;
          longitude?: number;
          address?: string;
        };
      }
    | undefined;
  const loc = data?.location;
  if (
    loc &&
    typeof loc.latitude === "number" &&
    typeof loc.longitude === "number"
  ) {
    return {
      latitude: loc.latitude,
      longitude: loc.longitude,
      address: loc.address,
    };
  }
  if (looksLikeAddress(msg.text)) {
    const geo = geocodePlaceholder(msg.text);
    return { latitude: geo.lat, longitude: geo.lon, address: msg.text.trim() };
  }
  return null;
}
function looksLikeAddress(text: string): boolean {
  const t = text.trim();
  if (t.length < 5) return false;
  const streetish = /\d+\s+\w+/.test(t);
  const areas = [
    "lekki",
    "yaba",
    "ikeja",
    "surulere",
    "victoria island",
    "vi",
    "ikoyi",
    "ajah",
    "gbagada",
    "maryland",
    "allen",
    "opebi",
  ];
  const hasArea = areas.some((a) => t.toLowerCase().includes(a));
  return streetish || hasArea;
}
function geocodePlaceholder(address: string): {
  lat: number;
  lon: number;
} {
  const LAGOS = { lat: 6.4541, lon: 3.3947 };
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) & 0xffff;
  }
  const jitter = (hash % 200) / 10000;
  return { lat: LAGOS.lat + jitter, lon: LAGOS.lon - jitter };
}
