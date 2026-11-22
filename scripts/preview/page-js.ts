// What the preview's control runs INSIDE a page (through the window's own DevTools session): the text of a document with its controls
// named, and the finder that picks the element a person would press. Strings, so they travel as `Runtime.evaluate` expressions.

/** The visible text of a document, one line per block, its controls in [brackets]: [button "Name"], [link "Name"], [field "placeholder" = "value"], [checkbox "Name" checked]. */
export const DUMP_JS = `(() => {
  const lines = [];
  let cur = [];
  const flush = () => { const t = cur.join(' ').replace(/\\s+/g, ' ').trim(); cur = []; if (t && lines[lines.length - 1] !== t) lines.push(t); };
  const shown = (e) => { try { return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { return true; } };
  const clip = (t) => { t = (t || '').replace(/\\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 67) + '...' : t; };
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;
  const CONTROL = 'button,a[href],input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[role=radio],[contenteditable=true]';
  const name = (e) => clip(e.getAttribute('aria-label') || e.innerText || e.textContent || e.title || e.getAttribute('placeholder') || '');
  const walk = (n) => {
    if (n.nodeType === 3) { cur.push(n.nodeValue); return; }
    if (n.nodeType !== 1) return;
    const e = n;
    const tag = e.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'head') return;
    if (!shown(e)) return;
    const block = BLOCK.test(getComputedStyle(e).display);
    if (block) flush();
    if (e.matches(CONTROL)) {
      const kind = tag === 'input' || tag === 'textarea' || e.getAttribute('contenteditable') === 'true'
        ? (e.type === 'checkbox' || e.type === 'radio' ? e.type : 'field')
        : tag === 'a' || e.getAttribute('role') === 'link' ? 'link' : tag === 'select' ? 'select' : (e.getAttribute('role') || 'button');
      if (kind === 'field') cur.push('[field ' + JSON.stringify(clip(e.getAttribute('aria-label') || e.getAttribute('placeholder') || '')) + (e.value ? ' = ' + JSON.stringify(clip(e.value)) : e.isContentEditable && e.innerText ? ' = ' + JSON.stringify(clip(e.innerText)) : '') + (document.activeElement === e ? ' focused' : '') + ']');
      else if (kind === 'checkbox' || kind === 'radio') cur.push('[' + kind + ' ' + JSON.stringify(name(e.labels && e.labels[0] ? e.labels[0] : e)) + (e.checked ? ' checked' : '') + ']');
      else if (kind === 'select') cur.push('[select ' + JSON.stringify(clip(e.options && e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : '')) + ']');
      else {
        const nm = name(e);
        const state = e.disabled || e.getAttribute('aria-disabled') === 'true' ? ' disabled' : e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-current') ? ' on' : '';
        cur.push('[' + kind + ' ' + JSON.stringify(nm) + state + ']');
      }
      if (block) flush();
      return;
    }
    if (tag === 'img' || tag === 'svg') { const al = e.getAttribute('aria-label') || e.getAttribute('alt'); if (al) cur.push('[image ' + JSON.stringify(clip(al)) + ']'); return; }
    for (const c of e.childNodes) walk(c);
    if (block) flush();
  };
  if (document.body) walk(document.body);
  flush();
  return lines.join('\\n');
})()`;

/** Marks the element a target names with `data-moss-ctl-target` and answers how many matched; the press then goes through the harness's own centre-finder (scroll into view, covered and clipped checks). */
export function findJs(target: { kind: "css"; selector: string } | { kind: "text"; text: string; exact: boolean }): string {
  return `(() => {
    for (const old of document.querySelectorAll('[data-moss-ctl-target]')) old.removeAttribute('data-moss-ctl-target');
    const shown = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && (typeof e.checkVisibility !== 'function' || e.checkVisibility()); };
    let el = null, n = 0;
    ${target.kind === "css"
      ? `const all = [...document.querySelectorAll(${JSON.stringify(target.selector)})].filter(shown); n = all.length; el = all[0] || null;`
      : `const want = ${JSON.stringify(target.text)}.toLowerCase(), exact = ${target.exact};
    const labels = (e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder'), e.getAttribute('alt'), e.value && e.tagName !== 'BUTTON' ? '' : '', ...((e.innerText || '').split('\\n'))].filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const CONTROL = 'button,a,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[tabindex]';
    const pool = (sel) => [...document.querySelectorAll(sel)].filter(shown);
    const hit = (e) => { const ls = labels(e); return exact ? ls.some((l) => l === want) : ls.some((l) => l === want) || ls.some((l) => l.includes(want)); };
    // a control first (an exact name before a partial one), then anything that shows the text itself.
    let found = pool(CONTROL).filter((e) => labels(e).some((l) => l === want));
    if (found.length === 0 && !exact) found = pool(CONTROL).filter(hit);
    if (found.length === 0) found = pool('body *').filter((e) => [...e.childNodes].some((c) => c.nodeType === 3 && (exact ? c.nodeValue.trim().toLowerCase() === want : c.nodeValue.toLowerCase().includes(want))));
    n = found.length; el = found[0] || null;`}
    if (el) el.setAttribute('data-moss-ctl-target', '1');
    return n;
  })()`;
}

export const CLEAR_TARGET_JS = `(() => { for (const e of document.querySelectorAll('[data-moss-ctl-target]')) e.removeAttribute('data-moss-ctl-target'); return true; })()`;
/** Whether a document has the keyboard's focus on something that takes typing or keys (its active element is not the page itself). */
export const FOCUS_JS = `(() => { const a = document.activeElement; return a !== null && a !== document.body && a !== document.documentElement ? (a.tagName || 'x').toLowerCase() : ''; })()`;
