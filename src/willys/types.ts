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
  // Cards saved on the account, which checkout can pay with.
  savedCards?: SavedCard[];
}

export interface SavedCard {
  id: string;
  expired?: boolean;
  defaultCard?: boolean;
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

export interface Money {
  value: number;
  formattedValue?: string;
}

export interface Cart {
  products: CartProduct[];
  totalPrice?: string;
  totalItems?: number;
  totalDiscount?: string;
  slot?: unknown;
  // Set while a placed order is open for changes ("Ändra order"): the
  // order's number. The cart then holds the order's lines and slot.
  orderReference?: string | null;
  // "PspPayexAll" for card payment.
  paymentType?: string | null;
  [key: string]: unknown;
}

// A placed order, as the account's order list has it.
export interface Order {
  orderNumber: string;
  // Whether willys.se still lets the order be changed.
  editable?: boolean;
  // Start of the pickup slot, epoch milliseconds.
  deliveryDateFrom?: number;
  // When it was placed, epoch milliseconds.
  placed?: number;
  // "1 412,15 kr".
  total?: string;
  statusDisplay?: string;
}

export interface OrderDetails extends Order {
  totalPrice?: string;
  cancelled?: boolean;
  // Until when the order can be changed: "Torsdag 12 Nov kl. 23:59".
  slotCloseTimeFormatted?: string;
}

// What checkout says about each line of the cart.
export interface CartStatus {
  cartStatus?: { updatedPrice?: boolean; outOfStock?: boolean; entryProduct?: { code?: string; name?: string } }[] | null;
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
