import { useEffect } from "react";

// Keep one request in flight and stop background work when the operator leaves
// the tab. A foreground return refreshes immediately instead of waiting a cycle.
export function useVisiblePolling(refresh: (signal: AbortSignal) => Promise<void>, interval = 5000) {
  useEffect(() => {
    let active = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (active && !document.hidden) timer = setTimeout(() => void run(), interval);
    };
    const run = async () => {
      if (!active || pending || document.hidden) return;
      clearTimeout(timer);
      pending = true;
      controller = new AbortController();
      try { await refresh(controller.signal); }
      catch { /* The caller owns operator-facing errors. */ }
      finally { pending = false; schedule(); }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void run();
    };
    void run();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [refresh, interval]);
}
