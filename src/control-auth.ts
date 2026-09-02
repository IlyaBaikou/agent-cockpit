import { timingSafeEqual } from "node:crypto";

export type ControlCredential = { actor: string; token: string };

export function parseControlCredentials(value = process.env.HUB_CONTROL_TOKENS ?? ""): ControlCredential[] {
  if (!value.trim()) {
    return [];
  }
  return value.split(",").map((entry) => {
    const [actor, ...tokenParts] = entry.split(":");
    const token = tokenParts.join(":");
    if (!actor?.trim() || !/^[a-zA-Z0-9._-]{2,64}$/.test(actor) || token.length < 24) {
      throw new Error("HUB_CONTROL_TOKENS must contain actor:token entries; tokens need 24+ characters");
    }
    return { actor, token };
  });
}

export function bearerToken(authorization: string | undefined): string {
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
}

export function secureTokenMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticateControl(token: string, credentials: ControlCredential[]): ControlCredential {
  const credential = credentials.find((candidate) => secureTokenMatch(token, candidate.token));
  if (!credential) {
    throw new Error("Unauthorized controller");
  }
  return credential;
}
