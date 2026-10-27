type UsageEvent =
  | "conversion-completed"
  | "sample-completed"
  | "edit-completed"
  | "pdf-downloaded";

type CountData = {
  path: string;
  title: string;
  referrer: string;
  event?: boolean;
  no_session?: boolean;
};

declare global {
  interface Window {
    goatcounter?: {
      no_onload: boolean;
      count?: (data: CountData) => void;
    };
  }
}

let ready = false;
let enabled = false;
const pending: UsageEvent[] = [];

export function initAnalytics() {
  const code = (import.meta.env.VITE_GOATCOUNTER_CODE ?? "").trim();
  if (
    enabled ||
    !import.meta.env.PROD ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(code) ||
    !/^https:$/.test(location.protocol) ||
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ||
    navigator.doNotTrack === "1"
  ) return;

  enabled = true;
  window.goatcounter = { no_onload: true };
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://gc.zgo.at/count.js";
  script.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  script.referrerPolicy = "no-referrer";
  script.onload = () => {
    ready = true;
    // Fixed labels avoid collecting query strings, document metadata, or URLs.
    count({ path: "/", title: "Natural Preprint", referrer: "" });
    pending.splice(0).forEach(trackUsage);
  };
  script.onerror = () => {
    enabled = false;
    pending.length = 0;
  };
  document.head.append(script);
}

function count(data: CountData) {
  try {
    window.goatcounter?.count?.(data);
  } catch {
    // Analytics must never interrupt conversion or downloads.
  }
}

export function trackUsage(event: UsageEvent) {
  if (!enabled) return;
  if (!ready) {
    if (pending.length < 20) pending.push(event);
    return;
  }
  count({ path: event, title: event, referrer: "", event: true, no_session: true });
}
