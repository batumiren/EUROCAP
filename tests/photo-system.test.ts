import { afterEach, describe, expect, it } from "vitest";
import { createPhotoSession, authenticatePhotoRequest, passwordsMatch } from "@/lib/photo-auth";
import { photoBlobPath, toPhotoMetadata } from "@/lib/inventory-photo-data";

describe("photo authentication", () => {
  afterEach(() => { delete process.env.EUROCAP_AUTH_SECRET; delete process.env.EUROCAP_PHOTO_PASSWORD; });

  it("creates and verifies signed admin bearer tokens", () => {
    process.env.EUROCAP_AUTH_SECRET = "test-secret";
    const token = createPhotoSession({ role: "admin", name: "ოპერატორი", email: "operator@example.com" });
    const request = new Request("http://localhost/photo", { headers: { Authorization: `Bearer ${token}` } });
    expect(authenticatePhotoRequest(request)).toMatchObject({ role: "admin", name: "ოპერატორი", email: "operator@example.com" });
    expect(authenticatePhotoRequest(new Request("http://localhost/photo"))).toBeNull();
  });

  it("compares the configured photo password", () => {
    process.env.EUROCAP_PHOTO_PASSWORD = "private-password";
    expect(passwordsMatch("private-password")).toBe(true);
    expect(passwordsMatch("wrong-password")).toBe(false);
  });
});

describe("photo metadata", () => {
  it("uses deterministic inventory-code filenames and hides the Blob path", () => {
    expect(photoBlobPath("EUR-000123", 0)).toBe("eurocap/inventory-photos/EUR-000123.jpg");
    expect(photoBlobPath("EUR-000123", 2)).toBe("eurocap/inventory-photos/EUR-000123-2.jpg");
    const metadata = toPhotoMetadata({ id: 1, inventory_id: 2, blob_path: "private/path.jpg", filename: "EUR-000123.jpg", original_name: "სურათი.png", width: 800, height: 600, byte_size: 99000, content_type: "image/jpeg", uploader: "ოპერატორი", uploaded_at: "2026-09-20T00:00:00.000Z", sha256: "a".repeat(64), sort_order: 0 });
    expect(metadata).not.toHaveProperty("blob_path");
    expect(metadata).toMatchObject({ filename: "EUR-000123.jpg", byteSize: 99000, width: 800, height: 600 });
  });
});
