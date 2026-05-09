"use client";

import { useEffect, useRef } from "react";

export type FacetOption = { value: string; label: string; count: number };

type Props = {
  label: string;
  options: FacetOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
};

export function FacetFilter({ label, options, selected, onToggle, onClear }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);

  // Close when clicking outside.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.open) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) {
        ref.current.open = false;
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const total = selected.size;
  const summaryLabel =
    total === 0 ? label : `${label} (${total})`;

  return (
    <details ref={ref} className="relative">
      <summary
        className={`flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border px-3 text-sm shadow-xs select-none ${
          total > 0 ? "border-foreground/40 bg-secondary" : "bg-transparent"
        }`}
      >
        <span>{summaryLabel}</span>
        <span aria-hidden className="ml-auto text-xs text-muted-foreground">▾</span>
      </summary>
      <div className="absolute left-0 z-20 mt-1 max-h-72 w-64 overflow-auto rounded-md border bg-popover p-1 shadow-md">
        {total > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="block w-full rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
          >
            Clear all ({total})
          </button>
        ) : null}
        {options.map((o) => {
          const checked = selected.has(o.value);
          return (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(o.value)}
                className="size-4"
              />
              <span className="flex-1 truncate">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.count}</span>
            </label>
          );
        })}
        {options.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">No options</p>
        ) : null}
      </div>
    </details>
  );
}
