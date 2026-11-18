// What went wrong when WhatsApp refused or failed to deliver one of our messages. Pure (unit-tested).
// The categories decide what we do: billing, account, permission and policy problems are NOT retried (retrying cannot fix
// them and may make things worse), the owner is told once a day, and the customer's message and chat are kept.

export type SendProblem = "billing" | "account" | "permission" | "policy" | "window" | "rate_limit" | "delivery";

// Meta's documented Cloud API error codes (the ones that matter here). Anything else is a plain delivery problem.
const BY_CODE: Record<number, SendProblem> = {
  131042: "billing",                                       // business eligibility: a payment problem
  131031: "account", 131030: "account", 131045: "account", 133010: "account", 133004: "account", 133005: "account", // account locked, number not registered, recipient not allowed (test number) ...
  190: "permission", 10: "permission", 3: "permission", 200: "permission", 201: "permission", 299: "permission", // expired or insufficient token / permission
  368: "policy", 131049: "policy", 131050: "policy", 131051: "policy", // policy block, marketing limits, unsupported content
  131047: "window",                                        // outside the 24-hour customer service window
  130429: "rate_limit", 131048: "rate_limit", 131056: "rate_limit", 80007: "rate_limit", 131000: "delivery",
};

export function classifyWhatsAppError(code: number | null | undefined, message: string | null | undefined): SendProblem {
  if (typeof code === "number" && BY_CODE[code]) return BY_CODE[code];
  const m = message ?? "";
  if (/payment|billing|credit line|eligib|insufficient (funds|balance)/i.test(m)) return "billing";
  if (/access token|permission|oauth|session has expired/i.test(m)) return "permission";
  if (/re-?engagement|24[- ]hour|outside .*window/i.test(m)) return "window";
  if (/rate limit|too many|throughput/i.test(m)) return "rate_limit";
  if (/policy|spam|blocked/i.test(m)) return "policy";
  if (/not registered|locked|disabled|banned|not allowed/i.test(m)) return "account";
  return "delivery";
}

/** Problems that retrying cannot fix: do not resend, and tell the owner. */
export const isBlockingProblem = (p: SendProblem) => p === "billing" || p === "account" || p === "permission" || p === "policy";

export const PROBLEM_LABELS: Record<SendProblem, string> = {
  billing: "a billing problem with your WhatsApp account",
  account: "a problem with your WhatsApp account or phone number",
  permission: "a permission problem (the connection to WhatsApp may have expired)",
  policy: "a WhatsApp policy block",
  window: "the 24-hour reply window being closed",
  rate_limit: "WhatsApp's sending limits",
  delivery: "a delivery problem",
};
