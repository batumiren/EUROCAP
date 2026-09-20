import { createHmac, timingSafeEqual } from "node:crypto";

export type PhotoAuthClaims = {
  role: "admin";
  name: string;
  email: string;
  exp: number;
};

function secret() {
  const value = process.env.EUROCAP_AUTH_SECRET;
  if (!value) throw new Error("EUROCAP_AUTH_SECRET is not configured.");
  return value;
}

function encode(value: object) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function signature(payload: string) { return createHmac("sha256", secret()).update(payload).digest("base64url"); }

export function createPhotoSession(claims: Omit<PhotoAuthClaims, "exp">) {
  const payload = encode({ ...claims, exp: Date.now() + 24 * 60 * 60 * 1000 });
  return `${payload}.${signature(payload)}`;
}

export function authenticatePhotoRequest(request: Request): PhotoAuthClaims | null {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const [payload, providedSignature] = token.split(".");
    if (!payload || !providedSignature) return null;
    const expected = Buffer.from(signature(payload));
    const provided = Buffer.from(providedSignature);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as PhotoAuthClaims;
    return claims.exp > Date.now() && claims.role === "admin" ? claims : null;
  } catch { return null; }
}

export function passwordsMatch(provided: string) {
  const configured = process.env.EUROCAP_PHOTO_PASSWORD;
  if (!configured) throw new Error("EUROCAP_PHOTO_PASSWORD is not configured.");
  const left = Buffer.from(provided);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}
