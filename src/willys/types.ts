// Shapes of the Willys (Axfood) web API responses, limited to the fields this
// project reads. The API is the one willys.se's own frontend calls; it is not
// documented or versioned, so every field is treated as possibly missing.

export interface Customer {
  uid: string;
  name?: string;
  firstName?: string;
  email?: string;
  storeId?: string;
  homeStoreId?: string;
}

export interface Promotion {
  code?: string;
  promotionType?: string;
  conditionLabel?: string | null;
  rewardLabel?: string | null;
  cartLabel?: string | null;
  textLabelGenerated?: string | null;
  comparePrice?: string | null;
  redeemLimitLabel?: string | null;
  qualifyingCount?: number | null;
  price?: number | null;
  validUntil?: number | null;
  lowestHistoricalPrice?: string | null;
}

export interface Product {
  code: string;
  name: string;
  manufacturer?: string;
  productLine2?: string;
  displayVolume?: string;
  priceValue: number;
  price?: string;
  priceNoUnit?: string;
  priceUnit?: string;
  comparePrice?: string;
  comparePriceUnit?: string;
  outOfStock?: boolean;
  online?: boolean;
  addToCartDisabled?: boolean;
  labels?: string[];
  potentialPromotions?: Promotion[];
  savingsAmount?: string | null;
  offlinePromotionLowestHistoricalPrice?: string | null;
}

// A product's page, as far as what it is made of.
export interface ProductInfo {
  code: string;
  name: string;
  brand: string | null;
  size: string | null;
  // Willys's category path, "Skafferi > Kryddor & smaksättare > Kryddor".
  category: string;
  // As printed on the pack, allergens in capitals; null when Willys has none.
  ingredients: string | null;
  labels: string[];
  diet: string | null;
  description: string | null;
  origin: string | null;
}

export interface Pagination {
  pageSize: number;
  currentPage: number;
  numberOfPages: number;
  totalNumberOfResults: number;
}

export interface ProductPage {
  results: Product[];
  pagination: Pagination;
}

export interface CartProduct {
  code: string;
  name: string;
  quantity: number;
  pickQuantity?: number;
  priceValue?: number;
  totalPrice?: string;
  manufacturer?: string;
  displayVolume?: string;
}

export interface Cart {
  products: CartProduct[];
  totalPrice?: string;
  totalItems?: number;
  totalDiscount?: string;
  slot?: unknown;
  [key: string]: unknown;
}

export interface Store {
  storeId: string;
  name: string;
  clickAndCollect?: boolean;
  onlineStore?: boolean;
  pickingCostForCollect?: string;
  openingHours?: string[];
  address?: { formattedAddress?: string };
}

export type CampaignKind = "online" | "offline";

export interface PickupSlot {
  code: string;
  // Epoch milliseconds.
  startTime: number;
  endTime: number;
  // Orders for the slot must be placed before this, epoch milliseconds.
  closeTime: number;
  available: boolean;
  // "Fredag 30 Okt 18:00-19:30".
  formattedTime: string;
  closeTimeFormatted?: string;
  totalCost?: { value: number; formattedValue: string };
}

export interface PickupSlots {
  slots: PickupSlot[];
  selectedSlot: PickupSlot | null;
  tmsSlots: boolean;
}
