"use client";

import {
  ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

const MAX_SIDE = 800;
const TARGET_BYTES = 100 * 1024;
const MIN_QUALITY = 0.35;

type Photo = {
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

export type InventoryPhotosProps = {
  inventoryId: number;
  itemCode: string;
  itemName: string;
  archived: boolean;
  photoCount: number;
  onPhotoCountChange: (count: number) => void;
};

type PreparedPhoto = {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
};

function messageFromResponse(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return fallback;
}

async function responseData(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} ბაიტი`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} კბ`;
}

function formatUploadedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ka-GE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tbilisi",
  }).format(date);
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("ფოტოს დამუშავება ვერ მოხერხდა.")),
      "image/jpeg",
      quality,
    );
  });
}

async function decodeImage(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap as CanvasImageSource,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("ფოტოს გახსნა ვერ მოხერხდა."));
      element.src = url;
    });
    return {
      source: image as CanvasImageSource,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name}: არჩეული ფაილი ფოტო არ არის.`);

  const image = await decodeImage(file);
  try {
    const initialScale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    let width = Math.max(1, Math.round(image.width * initialScale));
    let height = Math.max(1, Math.round(image.height * initialScale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("ფოტოს დამუშავება ვერ მოხერხდა.");

    const draw = () => {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image.source, 0, 0, width, height);
    };

    let smallest: { blob: Blob; width: number; height: number } | null = null;
    const qualities = [0.86, 0.76, 0.66, 0.56, 0.46, MIN_QUALITY, 0.25];
    draw();

    while (true) {
      for (const quality of qualities) {
        const blob = await canvasBlob(canvas, quality);
        if (!smallest || blob.size < smallest.blob.size) smallest = { blob, width, height };
        if (blob.size <= TARGET_BYTES) {
          return { blob, filename: jpegFilename(file.name), width, height };
        }
      }

      if (Math.max(width, height) <= 160) break;
      width = Math.max(1, Math.round(width * 0.85));
      height = Math.max(1, Math.round(height * 0.85));
      draw();
    }

    if (!smallest || smallest.blob.size > 512 * 1024) throw new Error(`${file.name}: ფოტო საკმარისად ვერ შეიკუმშა.`);
    return { ...smallest, filename: jpegFilename(file.name) };
  } finally {
    image.cleanup();
  }
}

function jpegFilename(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "").trim() || "photo";
  return `${base}.jpg`;
}

export function InventoryPhotos({
  inventoryId,
  itemCode,
  itemName,
  archived,
  photoCount,
  onPhotoCountChange,
}: InventoryPhotosProps) {
  const headingId = useId();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const [retry, setRetry] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [actionError, setActionError] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({});
  const [binaryLoading, setBinaryLoading] = useState<Record<number, boolean>>({});
  const [binaryErrors, setBinaryErrors] = useState<Record<number, string>>({});
  const [viewerPhotoId, setViewerPhotoId] = useState<number | null>(null);
  const urlsRef = useRef<Record<number, string>>({});
  const binaryRequests = useRef(new Map<number, { promise: Promise<void>; controller: AbortController }>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      binaryRequests.current.forEach(request => request.controller.abort());
      binaryRequests.current.clear();
      Object.values(urlsRef.current).forEach(url => URL.revokeObjectURL(url));
      urlsRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (photoCount <= 0) {
      setPhotos([]);
      setMetadataLoading(false);
      return;
    }

    const controller = new AbortController();
    setMetadataLoading(true);
    setMetadataError("");
    fetch(`/api/inventory/${inventoryId}/photos`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async response => {
      const data = await responseData(response);
      if (!response.ok) throw new Error(messageFromResponse(data, "ფოტოების სიის მიღება ვერ მოხერხდა."));
      const nextPhotos = data && typeof data === "object" && "photos" in data && Array.isArray(data.photos)
        ? data.photos as Photo[]
        : [];
      if (mountedRef.current) setPhotos(nextPhotos);
    }).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (mountedRef.current) setMetadataError(error instanceof Error ? error.message : "ფოტოების სიის მიღება ვერ მოხერხდა.");
    }).finally(() => {
      if (mountedRef.current && !controller.signal.aborted) setMetadataLoading(false);
    });

    return () => controller.abort();
  }, [inventoryId, photoCount, retry]);

  const fetchBinary = useCallback((photoId: number) => {
    if (urlsRef.current[photoId]) return Promise.resolve();
    const pending = binaryRequests.current.get(photoId);
    if (pending) return pending.promise;

    setBinaryLoading(current => ({ ...current, [photoId]: true }));
    setBinaryErrors(current => ({ ...current, [photoId]: "" }));
    const controller = new AbortController();
    const request = fetch(`/api/inventory/${inventoryId}/photos/${photoId}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) {
        const data = await responseData(response);
        throw new Error(messageFromResponse(data, "ფოტოს ჩატვირთვა ვერ მოხერხდა."));
      }
      const url = URL.createObjectURL(await response.blob());
      if (!mountedRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      const oldUrl = urlsRef.current[photoId];
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      urlsRef.current = { ...urlsRef.current, [photoId]: url };
      setPhotoUrls(urlsRef.current);
    }).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (mountedRef.current) {
        setBinaryErrors(current => ({
          ...current,
          [photoId]: error instanceof Error ? error.message : "ფოტოს ჩატვირთვა ვერ მოხერხდა.",
        }));
      }
    }).finally(() => {
      binaryRequests.current.delete(photoId);
      if (mountedRef.current) setBinaryLoading(current => ({ ...current, [photoId]: false }));
    });
    binaryRequests.current.set(photoId, { promise: request, controller });
    return request;
  }, [inventoryId]);

  useEffect(() => {
    if (viewerPhotoId !== null) void fetchBinary(viewerPhotoId);
  }, [fetchBinary, viewerPhotoId]);

  async function uploadPhotos(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files || []);
    input.value = "";
    if (!files.length || archived || deletingId !== null || uploading) return;

    setUploading(true);
    setActionError("");
    const prepared: Array<PreparedPhoto & { originalName: string }> = [];
    const failures: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setUploadProgress(`მუშავდება ${index + 1}/${files.length} · ${file.name}`);
      try {
        prepared.push({ ...(await preparePhoto(file)), originalName: file.name });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `${file.name}: ატვირთვა ვერ მოხერხდა.`);
      }
    }
    if (prepared.length) {
      setUploadProgress(`${prepared.length} ფოტო იტვირთება...`);
      try {
        const body = new FormData();
        prepared.forEach(photo => body.append("photos", photo.blob, photo.filename));
        body.append("metadata", JSON.stringify(prepared.map(photo => ({ originalName: photo.originalName }))));
        const response = await fetch(`/api/inventory/${inventoryId}/photos`, { method: "POST", body });
        const data = await responseData(response);
        if (!response.ok) throw new Error(messageFromResponse(data, "ფოტოების ატვირთვა ვერ მოხერხდა."));
        if (!data || typeof data !== "object" || !("photos" in data) || !Array.isArray(data.photos)) throw new Error("სერვერის პასუხი არასრულია.");
        const uploaded = data.photos as Photo[];
        setPhotos(current => [...current, ...uploaded]);
        onPhotoCountChange(photos.length + uploaded.length);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "ფოტოების ატვირთვა ვერ მოხერხდა.");
      }
    }
    if (!prepared.length && !failures.length) failures.push("აირჩიეთ სურათის ფორმატის ფაილი.");
    if (failures.length) setActionError(failures.join(" "));
    setUploadProgress("");
    setUploading(false);
  }

  async function deletePhoto(photo: Photo) {
    if (archived || uploading || deletingId !== null || !window.confirm(`ნამდვილად გსურთ „${photo.originalName}“ ფოტოს წაშლა?`)) return;
    setDeletingId(photo.id);
    setActionError("");
    try {
      const response = await fetch(`/api/inventory/${inventoryId}/photos/${photo.id}`, {
        method: "DELETE",
      });
      const data = await responseData(response);
      if (!response.ok) throw new Error(messageFromResponse(data, "ფოტოს წაშლა ვერ მოხერხდა."));
      setPhotos(current => current.filter(item => item.id !== photo.id));
      onPhotoCountChange(Math.max(0, photos.length - 1));
      if (viewerPhotoId === photo.id) setViewerPhotoId(null);
      const url = urlsRef.current[photo.id];
      binaryRequests.current.get(photo.id)?.controller.abort();
      binaryRequests.current.delete(photo.id);
      if (url) URL.revokeObjectURL(url);
      const nextUrls = { ...urlsRef.current };
      delete nextUrls[photo.id];
      urlsRef.current = nextUrls;
      setPhotoUrls(nextUrls);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "ფოტოს წაშლა ვერ მოხერხდა.");
    } finally {
      setDeletingId(null);
    }
  }

  const viewerIndex = viewerPhotoId === null ? -1 : photos.findIndex(photo => photo.id === viewerPhotoId);
  const viewerPhoto = viewerIndex >= 0 ? photos[viewerIndex] : null;
  const showPrevious = () => {
    if (photos.length < 2 || viewerIndex < 0) return;
    setViewerPhotoId(photos[(viewerIndex - 1 + photos.length) % photos.length].id);
  };
  const showNext = () => {
    if (photos.length < 2 || viewerIndex < 0) return;
    setViewerPhotoId(photos[(viewerIndex + 1) % photos.length].id);
  };

  return (
    <section className="card overflow-hidden" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 id={headingId} className="font-bold text-slate-900">ფოტოები</h3>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{metadataLoading ? photoCount : photos.length}</span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{itemCode} · {itemName}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!archived && (
            <label className={`btn-primary cursor-pointer focus-within:ring-2 focus-within:ring-blue-300 focus-within:ring-offset-2 ${uploading || deletingId !== null ? "pointer-events-none opacity-50" : ""}`}>
              <span>{uploading ? "მუშავდება..." : "+ ფოტოების დამატება"}</span>
              <input className="sr-only" type="file" accept="image/*" multiple disabled={uploading || deletingId !== null} onChange={uploadPhotos} />
            </label>
          )}
        </div>
      </header>

      <div className="p-4">
        {archived && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">არქივის ფოტოები მხოლოდ სანახავადაა ხელმისაწვდომი.</p>}
        {uploadProgress && <p className="mb-4 text-sm text-blue-700" role="status">ფოტო მუშავდება და იტვირთება: {uploadProgress}</p>}
        {actionError && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{actionError}</p>}

        {metadataLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4" aria-label="ფოტოები იტვირთება">
            {[0, 1, 2, 3].map(value => <div key={value} className="aspect-square animate-pulse rounded-lg bg-slate-100" />)}
          </div>
        ) : metadataError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center">
            <p className="text-sm text-red-700" role="alert">{metadataError}</p>
            <button className="btn-secondary mt-3" type="button" onClick={() => setRetry(value => value + 1)}>ხელახლა ცდა</button>
          </div>
        ) : photos.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="text-sm font-medium text-slate-600">ფოტოები ჯერ არ არის დამატებული.</p>
            {!archived && <p className="mt-1 text-xs text-slate-400">შეგიძლიათ ერთდროულად რამდენიმე ფოტო აირჩიოთ.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {photos.map(photo => (
              <PhotoThumbnail
                key={photo.id}
                photo={photo}
                url={photoUrls[photo.id]}
                loading={Boolean(binaryLoading[photo.id])}
                error={binaryErrors[photo.id]}
                archived={archived}
                deleting={deletingId === photo.id}
                onVisible={fetchBinary}
                onOpen={() => setViewerPhotoId(photo.id)}
                onDelete={() => void deletePhoto(photo)}
              />
            ))}
          </div>
        )}
      </div>

      {viewerPhoto && (
        <PhotoViewer
          photo={viewerPhoto}
          url={photoUrls[viewerPhoto.id]}
          loading={Boolean(binaryLoading[viewerPhoto.id])}
          error={binaryErrors[viewerPhoto.id]}
          position={viewerIndex + 1}
          total={photos.length}
          onClose={() => setViewerPhotoId(null)}
          onPrevious={showPrevious}
          onNext={showNext}
          onRetry={() => void fetchBinary(viewerPhoto.id)}
        />
      )}
    </section>
  );
}

function PhotoThumbnail({
  photo,
  url,
  loading,
  error,
  archived,
  deleting,
  onVisible,
  onOpen,
  onDelete,
}: {
  photo: Photo;
  url?: string;
  loading: boolean;
  error?: string;
  archived: boolean;
  deleting: boolean;
  onVisible: (photoId: number) => Promise<void>;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (url || !targetRef.current) return;
    const element = targetRef.current;
    if (!("IntersectionObserver" in window)) {
      void onVisible(photo.id);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        void onVisible(photo.id);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, photo.id, url]);

  return (
    <figure className="group overflow-hidden rounded-lg border bg-slate-50" ref={targetRef}>
      <button className="relative block aspect-square w-full overflow-hidden bg-slate-100 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500" type="button" onClick={onOpen} aria-label={`${photo.originalName} სრულ ეკრანზე ნახვა`}>
        {url ? (
          <img className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" src={url} alt={`${photo.originalName} — ინვენტარის ფოტო`} loading="lazy" />
        ) : error ? (
          <span className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-red-600">
            <span>ფოტო ვერ ჩაიტვირთა</span>
            <span className="font-semibold text-blue-700">ხელახლა ცდა</span>
          </span>
        ) : (
          <span className="flex h-full items-center justify-center">
            <span className={`h-8 w-8 rounded-full border-2 border-slate-300 ${loading ? "animate-spin border-t-blue-600" : ""}`} aria-hidden="true" />
            <span className="sr-only">ფოტო იტვირთება</span>
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/80 to-transparent px-2 pb-2 pt-8 text-xs font-medium text-white">
          <span className="block truncate">{photo.originalName}</span>
        </span>
      </button>
      <figcaption className="flex items-center justify-between gap-2 px-2 py-2 text-[11px] text-slate-500">
        <span>{photo.width}×{photo.height} · {formatBytes(photo.byteSize)}</span>
        {!archived && <button className="font-semibold text-red-600 hover:underline" type="button" disabled={deleting} onClick={onDelete}>{deleting ? "იშლება..." : "წაშლა"}</button>}
      </figcaption>
    </figure>
  );
}

function PhotoViewer({
  photo,
  url,
  loading,
  error,
  position,
  total,
  onClose,
  onPrevious,
  onNext,
  onRetry,
}: {
  photo: Photo;
  url?: string;
  loading: boolean;
  error?: string;
  position: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onPrevious();
      if (event.key === "ArrowRight") onNext();
    };
    const captureKey = (event: KeyboardEvent) => {
      if (["Escape", "ArrowLeft", "ArrowRight"].includes(event.key)) event.stopImmediatePropagation();
      keydown(event);
    };
    window.addEventListener("keydown", captureKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", captureKey, true);
    };
  }, [onClose, onNext, onPrevious]);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-950/95 text-white" role="dialog" aria-modal="true" aria-label={`${photo.originalName} ფოტოს ნახვა`} onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{photo.originalName}</p>
          <p className="text-xs text-slate-300">{position} / {total}</p>
        </div>
        <button className="rounded-lg p-2 text-2xl leading-none hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white" type="button" onClick={onClose} aria-label="სრულეკრანიანი ნახვის დახურვა" autoFocus>×</button>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" onMouseDown={event => event.target === event.currentTarget && onClose()}>
        {url ? (
          <img className="max-h-full max-w-full select-none object-contain" src={url} alt={`${photo.originalName} — ინვენტარის ფოტო`} loading="lazy" draggable={false} />
        ) : error ? (
          <div className="rounded-lg bg-white/10 p-5 text-center">
            <p className="text-sm text-red-200">{error}</p>
            <button className="mt-3 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900" type="button" onClick={onRetry}>ხელახლა ცდა</button>
          </div>
        ) : (
          <div className="text-center text-sm text-slate-300" role="status">
            <span className={`mx-auto mb-3 block h-10 w-10 rounded-full border-2 border-slate-500 ${loading ? "animate-spin border-t-white" : ""}`} />
            ფოტო იტვირთება...
          </div>
        )}

        {total > 1 && (
          <>
            <button className="absolute inset-y-0 left-0 flex w-1/4 items-center justify-start px-2 text-4xl text-white/80 hover:bg-gradient-to-r hover:from-black/30 hover:to-transparent focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white sm:px-5" type="button" onClick={onPrevious} aria-label="წინა ფოტო"><span className="rounded-full bg-black/40 px-3 py-1" aria-hidden="true">‹</span></button>
            <button className="absolute inset-y-0 right-0 flex w-1/4 items-center justify-end px-2 text-4xl text-white/80 hover:bg-gradient-to-l hover:from-black/30 hover:to-transparent focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white sm:px-5" type="button" onClick={onNext} aria-label="შემდეგი ფოტო"><span className="rounded-full bg-black/40 px-3 py-1" aria-hidden="true">›</span></button>
          </>
        )}
      </div>

      <footer className="border-t border-white/10 px-4 py-3 text-center text-xs text-slate-300">
        <p className="truncate"><span className="text-white">ამტვირთავი:</span> {photo.uploader || "უცნობია"} · {formatUploadedAt(photo.uploadedAt)}</p>
        <p className="mt-1">{photo.width}×{photo.height} · {formatBytes(photo.byteSize)}</p>
      </footer>
    </div>
  );
}

export default InventoryPhotos;
