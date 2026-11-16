import { keyProblem, type AiMode, type KeyStatus } from "./ai-keys";

// Pure helpers for the Settings page (unit-tested): which tab is open, and what is still missing
// before the assistant can answer customers.

export const SETTINGS_TABS = [
  { id: "business", label: "Business", blurb: "Your business name and booking link." },
  { id: "ai", label: "AI", blurb: "The AI provider and key that power your assistant." },
  { id: "workflows", label: "Workflows", blurb: "What the assistant collects from customers, and when it hands over to your team." },
  { id: "notifications", label: "Notifications", blurb: "Who is emailed, and how often." },
  { id: "whatsapp", label: "WhatsApp", blurb: "The number your customers message." },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** `?tab=` comes from the URL, so anything unknown falls back to `fallback`. */
export function parseTab(raw: unknown, fallback: SettingsTab = "business"): SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === raw) ? (raw as SettingsTab) : fallback;
}

export type SetupStep = { id: "ai" | "whatsapp" | "account"; tab: SettingsTab; done: boolean; title: string; detail: string };

export function assistantSetup(i: {
  mode: AiMode; hasKey: boolean; keyStatus: KeyStatus;
  hasPhone: boolean; onboardingStatus: string | null; clientStatus: string | null;
}): { ready: boolean; steps: SetupStep[]; firstTab: SettingsTab | null } {
  const problem = keyProblem(i.mode, i.hasKey, i.keyStatus);
  const failed = i.onboardingStatus === "failed";
  const steps: SetupStep[] = [
    {
      id: "ai", tab: "ai", done: !problem,
      title: problem === "invalid" ? "Replace your AI key" : problem === "missing" ? "Add your AI key" : "AI is set up",
      detail: problem === "invalid"
        ? "Your AI provider refused your key. Until you add a working one, customers get a short \"our team will reply\" message and their chats wait in Human handoff."
        : problem === "missing"
          ? "The assistant needs your AI provider key to answer. Until you add it, customers get a short \"our team will reply\" message and their chats wait in Human handoff."
          : "The assistant can use your AI account.",
    },
    {
      id: "whatsapp", tab: "whatsapp", done: i.hasPhone && !failed,
      title: !i.hasPhone ? "Connect your WhatsApp number" : failed ? "Reconnect your WhatsApp number" : "WhatsApp is connected",
      detail: !i.hasPhone
        ? "No WhatsApp number is connected, so there are no customer chats to answer yet."
        : failed ? "The last connection attempt did not finish." : "Customer messages reach the assistant.",
    },
  ];
  // A connected business that is still switched off (not a failed connection): only the platform admin can change this.
  if (i.hasPhone && !failed && i.clientStatus === "paused") {
    steps.push({ id: "account", tab: "whatsapp", done: false, title: "Your account is paused", detail: "The assistant is off for this account. Please contact the platform admin." });
  }
  const todo = steps.find((s) => !s.done);
  return { ready: !todo, steps, firstTab: todo?.tab ?? null };
}
