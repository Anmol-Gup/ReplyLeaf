"use client";

import { useRef, useState } from "react";

// Launches Meta's Embedded Signup popup (v4) and hands the result to our server.
// This uses Meta's JS SDK ONLY to connect a WhatsApp number. It is not a login:
// owners sign in with email and password.
//
// The popup yields two things: an auth `code` (valid ~30 seconds) from FB.login,
// and the waba_id / phone_number_id from a window "message" event. Both go to
// /onboarding/callback, where the code is exchanged on the server.

type FB = {
  init(o: { appId: string; version: string; xfbml: boolean; cookie: boolean }): void;
  login(cb: (r: { authResponse?: { code?: string } }) => void, o: object): void;
};
declare global { interface Window { FB?: FB } }

// phoneNumberId is absent when the owner keeps using the WhatsApp Business app (coexistence):
// Meta reports only the WABA then, and the server looks the number up.
type Assets = { wabaId: string; phoneNumberId?: string };

export default function EmbeddedSignup(p: { appId: string; configId: string; graphVersion: string; state: string; defaultName: string }) {
  const [name, setName] = useState(p.defaultName);
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const assets = useRef<Assets | null>(null);

  const loadSdk = () =>
    new Promise<FB>((resolve, reject) => {
      if (window.FB) return resolve(window.FB);
      const s = document.createElement("script");
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      s.async = true;
      s.onload = () => (window.FB ? resolve(window.FB) : reject(new Error("sdk")));
      s.onerror = () => reject(new Error("sdk"));
      document.body.appendChild(s);
    });

  async function start() {
    // Meta's SDK refuses to open the popup from any http:// page (even localhost).
    if (window.location.protocol !== "https:") {
      setStatus("error");
      setMessage("WhatsApp only allows this connection from a secure address. Open this page using an https:// address (your deployed site, or an https tunnel such as ngrok), not http://.");
      return;
    }
    if (!name.trim()) { setStatus("error"); setMessage("Please enter your business name first."); return; }
    if (!acknowledged) { setStatus("error"); setMessage("Please confirm that you understand the WhatsApp messaging charges first."); return; }
    setStatus("working"); setMessage("Waiting for the WhatsApp window...");
    assets.current = null;

    // Only trust messages from facebook.com origins.
    const onMessage = (e: MessageEvent) => {
      if (!/^https:\/\/([a-z0-9-]+\.)*facebook\.com$/.test(e.origin)) return;
      try {
        const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (d?.type === "WA_EMBEDDED_SIGNUP" && d.event === "FINISH" && d.data?.waba_id && d.data?.phone_number_id) {
          assets.current = { wabaId: String(d.data.waba_id), phoneNumberId: String(d.data.phone_number_id) };
        } else if (d?.type === "WA_EMBEDDED_SIGNUP" && d.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" && d.data?.waba_id) {
          assets.current = { wabaId: String(d.data.waba_id) };
        } else if (d?.type === "WA_EMBEDDED_SIGNUP" && (d.event === "CANCEL" || d.event === "ERROR")) {
          setStatus("error"); setMessage("The setup was cancelled before it finished.");
        }
      } catch { /* not our message */ }
    };
    window.addEventListener("message", onMessage);

    try {
      const fb = await loadSdk();
      fb.init({ appId: p.appId, version: p.graphVersion, xfbml: false, cookie: false });
      fb.login(
        (r) => {
          const code = r.authResponse?.code;
          if (!code) { window.removeEventListener("message", onMessage); setStatus("error"); setMessage("The setup was not completed."); return; }
          void finish(code, onMessage);
        },
        { config_id: p.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" } },
      );
    } catch {
      window.removeEventListener("message", onMessage);
      setStatus("error"); setMessage("Could not load the WhatsApp setup. Check your connection and try again.");
    }
  }

  async function finish(code: string, onMessage: (e: MessageEvent) => void) {
    // The asset event can arrive just after the login callback; wait briefly for it.
    for (let i = 0; i < 40 && !assets.current; i++) await new Promise((r) => setTimeout(r, 250));
    window.removeEventListener("message", onMessage);
    if (!assets.current) { setStatus("error"); setMessage("WhatsApp did not report which number was connected. Please try again."); return; }

    setMessage("Connecting your number...");
    const res = await fetch("/onboarding/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, ...assets.current, name: name.trim(), state: p.state, acknowledged }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (res.ok && body?.ok) { setStatus("done"); setMessage("Connected! Taking you to your dashboard..."); window.location.href = "/dashboard"; }
    else { setStatus("error"); setMessage(body?.error ?? "Something went wrong. Please try again."); }
  }

  return (
    <div className="stack">
      <p className="muted">Connect the WhatsApp Business number your customers will message. You will sign in to WhatsApp in a pop-up; we never see your password.</p>
      <p className="muted">Already use the WhatsApp Business app on your phone? Choose that number in the pop-up and keep using the app: you can reply to customers yourself, and the assistant steps aside for that chat when you do.</p>
      <label className="field">Business name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></label>
      <label className="check" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} style={{ marginTop: 4 }} />
        <span>I understand that WhatsApp messaging charges are separate from my Replyleaf subscription and are billed by Meta or my messaging provider.</span>
      </label>
      {message && <p className={`notice ${status === "error" ? "error" : status === "done" ? "ok" : ""}`} role={status === "error" ? "alert" : "status"}>{message}</p>}
      <div>
        <button type="button" className="btn btn-primary" onClick={start} disabled={status === "working" || status === "done" || !acknowledged} aria-busy={status === "working"}>
          {status === "working" && <span className="spinner" aria-hidden="true" />}
          {status === "working" ? "Connecting..." : "Connect WhatsApp"}
        </button>
      </div>
    </div>
  );
}
