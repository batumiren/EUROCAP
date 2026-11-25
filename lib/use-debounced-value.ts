import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delay = 300) {
  const [stable, setStable] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setStable(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return stable;
}
