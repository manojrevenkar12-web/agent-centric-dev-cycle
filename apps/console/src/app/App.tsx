import { useEffect, useState } from "react";
import { BenchScreen } from "../features/bench/BenchScreen";
import { LoopScreen } from "../features/loop/LoopScreen";
import { SafetyScreen } from "../features/safety/SafetyScreen";
import { SignalsScreen } from "../features/signals/SignalsScreen";

type Route =
  | { page: "loop"; id: string | null }
  | { page: "signals" }
  | { page: "bench" }
  | { page: "safety" };

export function parse(hash: string): Route {
  const [, page, id] = hash.replace(/^#/, "").split("/");
  if (page === "signals" || page === "bench" || page === "safety") return { page };
  return { page: "loop", id: id || null };
}

const LINKS: { page: Route["page"]; href: string; label: string }[] = [
  { page: "loop", href: "#/runs", label: "Agent runs" },
  { page: "signals", href: "#/signals", label: "Signals" },
  { page: "bench", href: "#/bench", label: "Benchmark" },
  { page: "safety", href: "#/safety", label: "Safety model" },
];

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <div className="shell">
      <header className="rail">
        <span className="brand">ACDC</span>
        <p className="brand-note">
          Issues to merged pull requests, with agents doing the work and people deciding.
        </p>
        <nav aria-label="Sections">
          {LINKS.map((l) => (
            <a key={l.page} href={l.href} aria-current={route.page === l.page ? "page" : undefined}>
              {l.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {route.page === "loop" && <LoopScreen id={route.id} />}
        {route.page === "signals" && <SignalsScreen />}
        {route.page === "bench" && <BenchScreen />}
        {route.page === "safety" && <SafetyScreen />}
      </main>
    </div>
  );
}
