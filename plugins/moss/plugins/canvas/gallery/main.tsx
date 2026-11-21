// The canvas gallery: one page, every story, light and dark. `#story=<id>` shows one story filling the window (the
// pictures are taken that way); `#theme=dark` starts dark. Built into one self-contained file by build.ts.
import "../../shell/gallery/theme.css";
import "../client/styles.css";
import "./page.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { STORIES } from "./stories";

const hash = () => new URLSearchParams(globalThis.location?.hash.slice(1) ?? "");

function Gallery() {
  const [params, setParams] = useState(hash);
  useEffect(() => {
    const on = () => setParams(hash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const story = STORIES.find((s) => s.id === params.get("story")) ?? STORIES[0]!;
  const bare = params.get("bare") === "1";
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  // The pictures pin each animation part-way (page.css): a headless capture doesn't advance them.
  useEffect(() => { if (params.get("freeze") === "1") document.documentElement.dataset.freeze = ""; else delete document.documentElement.dataset.freeze; }, [params]);
  const go = (next: Record<string, string>) => {
    const p = hash();
    for (const [k, v] of Object.entries(next)) p.set(k, v);
    location.hash = p.toString();
  };
  if (bare) return <main className="g-bare" data-story={story.id}>{story.render()}</main>;
  return (
    <main className="g-page">
      <nav className="g-nav" aria-label="Stories">
        <h1 className="g-nav__title">Session canvas</h1>
        <p className="g-nav__intro">MOSS Code's start page, the canvas plugin's own parts over the spine's sample scene. Pretend data; nothing here reaches MOSS.</p>
        <span className="g-theme" role="group" aria-label="Theme">
          {(["light", "dark"] as const).map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => go({ theme: t })}>{t}</button>)}
        </span>
        <ul>
          {STORIES.map((s) => (
            <li key={s.id}><a href={`#story=${s.id}&theme=${theme}`} aria-current={s.id === story.id ? "page" : undefined}>{s.title}</a></li>
          ))}
        </ul>
      </nav>
      <section className="g-story" key={`${story.id}-${theme}`}>
        <header className="g-story__head">
          <h2>{story.title}</h2>
          {story.notes !== undefined && <p>{story.notes}</p>}
        </header>
        <div className="g-frame" data-story={story.id}>{story.render()}</div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
