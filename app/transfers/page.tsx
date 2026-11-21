"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Empty, fetchJson, formatDate, Modal, Notice, submitJson } from "@/components/ui";
import { InventoryItem } from "@/lib/types";

type Room = { id: number; name: string };
type Transfer = {
  id: number;
  created_at: string;
  source_code_snapshot: string;
  destination_code_snapshot: string;
  item_name_snapshot: string;
  quantity: number;
  source_room_snapshot: string;
  destination_room_snapshot: string;
  reason: string;
};

export default function TransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [filters, setFilters] = useState({ search: "", room: "", date: "" });
  const [open, setOpen] = useState(false);
  const [sourceRoom, setSourceRoom] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [destination, setDestination] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const query = new URLSearchParams(filters);
    const [transferData, inventoryData, roomData] = await Promise.all([
      fetchJson<{ transfers: Transfer[] }>(`/api/transfers?${query}`),
      fetchJson<{ items: InventoryItem[] }>("/api/inventory"),
      fetchJson<{ rooms: Room[] }>("/api/rooms"),
    ]);
    setTransfers(transferData.transfers);
    setItems(inventoryData.items);
    setRooms(roomData.rooms);
  }, [filters]);

  useEffect(() => { void load().catch(error => setError(error.message)); }, [load]);

  const sourceItems = sourceRoom ? items.filter(item => item.room_id === Number(sourceRoom)) : [];
  const sourceRoomName = rooms.find(room => room.id === Number(sourceRoom))?.name;
  const destinationRoomName = rooms.find(room => room.id === Number(destination))?.name;

  function reset() {
    setSourceRoom("");
    setSelectedIds(new Set());
    setDestination("");
    setReason("");
  }

  function toggleItem(id: number) {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await submitJson("/api/transfers", "POST", {
        sourceRoomId: Number(sourceRoom),
        inventoryIds: [...selectedIds],
        destinationRoomId: Number(destination),
        reason,
      }) as { created: number };
      setOpen(false);
      reset();
      await load();
      setMessage(`${result.created} ჩანაწერის გადაადგილება დასრულდა.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "გადაადგილება ვერ შესრულდა.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="mx-auto max-w-7xl">
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-2xl font-bold">გადაადგილება</h1><p className="mt-1 text-sm text-slate-500">ინვენტარის უსაფრთხო გადატანა ოთახებს შორის</p></div>
      <button className="btn-primary" onClick={() => { reset(); setOpen(true); setMessage(""); }}>+ ახალი გადაადგილება</button>
    </div>
    {message && <Notice message={message} />} {error && <Notice message={error} error />}
    <div className="card mb-5 grid gap-3 p-4 sm:grid-cols-3">
      <input placeholder="ნივთის კოდი ან დასახელება" aria-label="ნივთის ძებნა" value={filters.search} onChange={event => setFilters({ ...filters, search: event.target.value })} />
      <input placeholder="საწყისი ან დანიშნულების ოთახი" aria-label="ოთახის ძებნა" value={filters.room} onChange={event => setFilters({ ...filters, room: event.target.value })} />
      <input type="date" aria-label="თარიღი" value={filters.date} onChange={event => setFilters({ ...filters, date: event.target.value })} />
    </div>
    {!transfers.length ? <Empty>გადაადგილებების ისტორია ჯერ ცარიელია.</Empty> : <div className="table-wrap"><table><thead><tr>{["თარიღი", "ნივთის ID", "დასახელება", "რაოდენობა", "საიდან", "სად", "კომენტარი"].map(heading => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{transfers.map(transfer => <tr key={transfer.id}><td>{formatDate(transfer.created_at)}</td><td><b>{transfer.source_code_snapshot}</b>{transfer.source_code_snapshot !== transfer.destination_code_snapshot && <><br /><span className="text-xs text-slate-500">→ {transfer.destination_code_snapshot}</span></>}</td><td>{transfer.item_name_snapshot}</td><td>{transfer.quantity}</td><td>{transfer.source_room_snapshot}</td><td>{transfer.destination_room_snapshot}</td><td className="max-w-xs whitespace-normal">{transfer.reason || "—"}</td></tr>)}</tbody></table></div>}

    {open && <Modal title="ახალი გადაადგილება" onClose={() => { setOpen(false); reset(); }}>
      <form onSubmit={submit} className="space-y-4">
        <label><span className="label">საწყისი ოთახი *</span><select required className="w-full" value={sourceRoom} onChange={event => { setSourceRoom(event.target.value); setSelectedIds(new Set()); setDestination(""); }}><option value="">აირჩიეთ ოთახი</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>

        {sourceRoom && <div>
          <p className="label">გადასატანი ინვენტარი *</p>
          {sourceItems.length ? <div className="max-h-72 overflow-y-auto rounded-lg border bg-white">
            {sourceItems.map(item => <label key={item.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-slate-50"><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleItem(item.id)} /><span className="font-semibold text-blue-700">{item.code}</span><span className="text-sm text-slate-700">{item.name}</span></label>)}
          </div> : <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">ამ ოთახში აქტიური ინვენტარი არ არის.</p>}
          {sourceItems.length > 0 && <p className="mt-1 text-xs text-slate-500">არჩეულია {selectedIds.size} / {sourceItems.length} ჩანაწერი</p>}
        </div>}

        <label><span className="label">დანიშნულების ოთახი *</span><select required className="w-full" disabled={!sourceRoom} value={destination} onChange={event => setDestination(event.target.value)}><option value="">აირჩიეთ ოთახი</option>{rooms.filter(room => room.id !== Number(sourceRoom)).map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
        <label><span className="label">კომენტარი</span><textarea className="w-full" rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label>
        {selectedIds.size > 0 && destinationRoomName && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950"><b>დადასტურება:</b> {selectedIds.size} ჩანაწერი, {sourceRoomName} → {destinationRoomName}</div>}
        <button className="btn-primary w-full" disabled={saving || selectedIds.size === 0 || !destination}>{saving ? "ინახება..." : "გადაადგილების დადასტურება"}</button>
      </form>
    </Modal>}
  </div>;
}
