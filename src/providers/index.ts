import type { DeliveryProvider, AffiliateProvider } from "./types.js";
import { GlovoProvider } from "./glovo.js";
import { StubDeliveryProvider } from "./stub.js";
import { SimpleAffiliateProvider } from "./affiliate.js";
import { childLogger } from "../core/logger.js";
const log = childLogger("providers");
function selectDeliveryProvider(): DeliveryProvider {
  const glovo = new GlovoProvider();
  if (glovo.live) {
    log.info("Using Glovo as delivery provider (live).");
    return glovo;
  }
  log.info("Using stub delivery provider (no Glovo credentials).");
  return new StubDeliveryProvider();
}

export const deliveryProvider: DeliveryProvider = selectDeliveryProvider();
export const affiliateProvider: AffiliateProvider =
  new SimpleAffiliateProvider();

export type {
  DeliveryProvider,
  AffiliateProvider,
  DeliveryQuote,
  DeliveryOrder,
} from "./types.js";
