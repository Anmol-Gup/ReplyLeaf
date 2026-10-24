import { randomInt } from "node:crypto";

// Random password for a new admin login. No look-alike characters (0/O, 1/l/I) so it can be
// read off a terminal; drawn with a cryptographic RNG.
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%";

export function generatePassword(length = 20): string {
  if (length < 12) throw new Error("password length must be at least 12");
  return Array.from({ length }, () => CHARS[randomInt(CHARS.length)]).join("");
}
