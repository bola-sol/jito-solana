import { useEffect, useState, type ReactNode } from "react";

/** Text that copies itself when clicked. A button, truncated with an
 *  ellipsis; the confirmation is drawn over the value so nothing reflows. */
export function Copyable({
  text,
  label,
  className,
}: {
  text: string;
  /** What to show, when that differs from what to copy. */
  label?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (await writeToClipboard(text)) setCopied(true);
  };

  return (
    <button
      type="button"
      className={`copyable${copied ? " copied" : ""}${className ? ` ${className}` : ""}`}
      onClick={copy}
      // Named explicitly because the value is hidden while the confirmation
      // shows, which would otherwise leave the button briefly nameless.
      aria-label={text}
      title={copied ? "Copied" : `${text}\nClick to copy`}
    >
      <span className="copyable-text">{label ?? text}</span>
      <span className="copyable-flash" aria-hidden="true">
        copied
      </span>
    </button>
  );
}

/** `navigator.clipboard` needs a secure context; fall back to the
 *  selection-based copy over plain HTTP. */
async function writeToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through; a permission failure is still worth retrying the old way.
    }
  }

  const staging = document.createElement("textarea");
  staging.value = text;
  // Kept out of view and out of the tab order while it is briefly focused.
  staging.setAttribute("readonly", "");
  staging.style.position = "fixed";
  staging.style.top = "-1000px";
  staging.style.opacity = "0";
  document.body.appendChild(staging);
  staging.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  document.body.removeChild(staging);
  return copied;
}
