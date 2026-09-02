const BUTTON_TEXT: Record<string, string> = {
  menu_food: "order food",
  menu_gift: "send a gift",
  menu_shop: "buy",
  confirm_item: "yes",
  confirm_order: "yes",
  cancel: "cancel",
};

export function buttonIdToText(id: string): string {
  return BUTTON_TEXT[id] ?? id;
}
