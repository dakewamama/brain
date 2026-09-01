import { getConfig } from "./config.js";

export type Kobo = number;
export function formatNaira(kobo: Kobo): string {
  const naira = kobo / 100;
  const hasFraction = kobo % 100 !== 0;
  return (
    "₦" +
    naira.toLocaleString("en-NG", {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}

export function axisFee(subtotalKobo: Kobo): Kobo {
  const cfg = getConfig();
  const bpsPart = Math.round((subtotalKobo * cfg.AXIS_FEE_BPS) / 10000);
  return bpsPart + cfg.AXIS_FEE_FLAT_KOBO;
}

export function orderTotal(params: {
  subtotalKobo: Kobo;
  deliveryKobo: Kobo;
}): {
  feeKobo: Kobo;
  totalKobo: Kobo;
} {
  const feeKobo = axisFee(params.subtotalKobo);
  return {
    feeKobo,
    totalKobo: params.subtotalKobo + params.deliveryKobo + feeKobo,
  };
}
