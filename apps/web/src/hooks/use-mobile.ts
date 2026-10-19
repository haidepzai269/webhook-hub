import * as React from "react";

const MOBILE_BREAKPOINT = 768; // = breakpoint `md` của Tailwind

/** `undefined` = chưa đo (SSR / render đầu) — nơi tốn tài nguyên (canvas) chờ đo xong rồi mới dựng. */
export function useIsMobileState(): boolean | undefined {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

export function useIsMobile() {
  return !!useIsMobileState();
}
