// Every link the conversation draws goes through here (review item 3): one rule for what may open,
// footnotes that stay inside the view, and a middle-click that never navigates on its own.
import { Children, isValidElement, type MouseEvent, type ReactNode } from "react";
import { fragmentOf, safeLink, scrollToFragment, targetOf, wordsShowTarget } from "./links";

/** The words a link shows, as plain text (what a person reads, whatever the markup around it). */
function wordsOf(node: ReactNode): string {
  return Children.toArray(node).map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement(c) ? wordsOf((c.props as { children?: ReactNode }).children) : "")).join("");
}

export interface LinkProps {
  href: string | undefined;
  onOpenLink?: (url: string) => void;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function Link({ href, onOpenLink, className, title, children }: LinkProps) {
  const fragment = fragmentOf(href);
  if (fragment !== undefined) {
    return (
      <a
        className={className}
        href={`#${fragment}`}
        onClick={(e) => {
          e.preventDefault();
          scrollToFragment(e.currentTarget, fragment);
        }}
        onAuxClick={(e) => e.preventDefault()}
      >
        {children}
      </a>
    );
  }
  const url = safeLink(href);
  if (url === undefined) {
    return (
      <span className={className} data-blocked="">
        {children}
      </span>
    );
  }
  const open = (e: MouseEvent) => {
    e.preventDefault();
    onOpenLink?.(url);
  };
  // The target is never hidden behind other words: unless the words already say it, its host follows them, muted.
  const target = targetOf(url);
  const words = wordsOf(children);
  const showTarget = target !== undefined && !wordsShowTarget(words, url);
  return (
    <>
    <a
      className={className}
      href={url}
      title={title ?? url}
      rel="noreferrer"
      onClick={open}
      onAuxClick={(e) => {
        e.preventDefault();
        if (e.button === 1) onOpenLink?.(url);
      }}
    >
      {children}
    </a>
    {showTarget ? <span className="cl-conv-md__host" data-link-host>{` (${target})`}</span> : null}
    </>
  );
}
