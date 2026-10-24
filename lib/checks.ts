// Turns the daily_reply_check rows into a human summary and decides whether
// anything needs the admin's attention. Pure, so it is unit-tested.

export type CheckRow = {
  out_client_id: string;
  out_client_name: string;
  out_received: number | string;
  out_replied: number | string;
  out_unreplied: number | string;
  out_failed: number | string;
  out_stuck: number | string;
};

export type CheckSummary = { hasIssues: boolean; issueCount: number; text: string };

export function summarizeDailyCheck(rows: CheckRow[]): CheckSummary {
  const lines: string[] = [];
  let issueCount = 0;
  for (const r of rows) {
    const received = Number(r.out_received);
    const replied = Number(r.out_replied);
    const unreplied = Number(r.out_unreplied);
    const failed = Number(r.out_failed);
    const stuck = Number(r.out_stuck);
    const problems = [
      unreplied > 0 && `${unreplied} conversation(s) with no reply`,
      failed > 0 && `${failed} failed/blocked send(s)`,
      stuck > 0 && `${stuck} stuck batch(es)`,
    ].filter(Boolean);
    if (problems.length) issueCount++;
    lines.push(`${problems.length ? "PROBLEM" : "ok     "}  ${r.out_client_name}: received ${received}, replied ${replied}${problems.length ? ` | ${problems.join(", ")}` : ""}`);
  }
  if (rows.length === 0) lines.push("No active clients.");
  return { hasIssues: issueCount > 0, issueCount, text: `Last 24 hours, messages received vs replies sent:\n\n${lines.join("\n")}` };
}
