import { useCallback, useEffect, useState } from "react";

/** Poll without overlapping requests; discard responses after navigation or unmount. */
export function usePolling<T>(fetcher: () => Promise<T>, interval = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    let active = true, fetching = false;
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await fetcher();
        if (active) { setData(next); setError(""); }
      } catch {
        if (active) setError("Couldn't refresh this page. Check that the dashboard server is running.");
      } finally { fetching = false; }
    };
    void load();
    const timer = window.setInterval(load, interval);
    return () => { active = false; window.clearInterval(timer); };
  }, [fetcher, interval, revision]);
  return { data, error, reload };
}
