export const CONDITIONS = ["კარგი", "დამაკმაყოფილებელი", "დაზიანებული", "საჭიროებს შეკეთებას"] as const;
export const STATUSES = ["გამოყენებაში", "საწყობში", "ჩამოწერილი", "მცირეფასიანი მარაგები"] as const;

export type Condition = (typeof CONDITIONS)[number];
export type ItemStatus = (typeof STATUSES)[number];

export type InventoryItem = {
  id: number;
  code: string;
  name: string;
  room_id: number;
  room_name: string;
  quantity: number;
  condition: Condition;
  status: ItemStatus;
  notes: string;
  responsible_person: string;
  registered_at: string;
  last_inspected_at: string | null;
  archived_at: string | null;
  updated_at: string;
  photoCount: number;
};

export type InventoryPhoto = {
  id: number;
  filename: string;
  originalName: string;
  width: number;
  height: number;
  byteSize: number;
  uploader: string;
  uploadedAt: string;
  sha256: string;
};
