import React, { useEffect, useRef } from 'react';

// Renders admin-provided HTML raw, without sanitization, and executes any
// <script> elements it contains. Used for the forum header/footer HTML,
// where the admin deliberately saved the markup that should reach visitors.
//
// Trust boundary: the header/footer fields are admin-only, and an admin can
// already run arbitrary JS in every visitor's browser through the design JS
// field (DesignProvider injects it as a script element), so rendering this
// HTML raw does not expand what an admin can do — it only stops stripping
// the markup the admin deliberately saved.
//
// Scripts inserted through innerHTML never execute, so each <script> found
// in the markup is replaced with a freshly created script element carrying
// the same attributes (src, type, async, defer, ...) and text content —
// the same forced-execution trick DesignProvider uses for the design JS.
// Classic scripts get async=false unless the author asked for async/defer,
// so they run in document order; module scripts keep their default
// deferred behaviour.
//
// When the HTML value changes, setting innerHTML replaces the old content
// (old script elements leave the DOM with it) and the new scripts execute.
// On unmount React removes the container, so nothing is left behind.
const CLASSIC_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

function executeScripts(container) {
  const scripts = Array.from(container.querySelectorAll('script'));
  scripts.forEach((oldScript) => {
    const script = document.createElement('script');
    Array.from(oldScript.attributes).forEach((attr) => {
      script.setAttribute(attr.name, attr.value);
    });
    const type = (oldScript.getAttribute('type') || '').trim().toLowerCase();
    const isClassic = CLASSIC_SCRIPT_TYPES.has(type);
    if (isClassic && !oldScript.hasAttribute('async') && !oldScript.hasAttribute('defer')) {
      // Dynamically created scripts default to async; pin classic scripts
      // to document order unless the author opted out.
      script.async = false;
    }
    script.textContent = oldScript.textContent;
    oldScript.replaceWith(script);
  });
}

const RawHtml = ({ html, className, id }) => {
  const ref = useRef(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    if (!html || !html.trim()) return;
    // StrictMode re-runs effects in dev with the same value: skip the
    // second pass so scripts do not execute twice for one render.
    if (container.dataset.executedFor === html) return;
    container.innerHTML = html;
    executeScripts(container);
    container.dataset.executedFor = html;
  }, [html]);

  // Empty value renders nothing: no empty block, no extra spacing.
  if (!html || !html.trim()) return null;
  return <div ref={ref} className={className} id={id} />;
};

export default RawHtml;
