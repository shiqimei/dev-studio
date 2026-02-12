import { useEffect, useRef, forwardRef } from "react";

export interface AutocompleteItem {
  key: string;
  label: string;
  description?: string;
}

interface AutocompleteDropdownProps {
  items: AutocompleteItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

export const AutocompleteDropdown = forwardRef<HTMLDivElement, AutocompleteDropdownProps>(
  function AutocompleteDropdown({ items, activeIndex, onSelect, onHover }, ref) {
    const internalRef = useRef<HTMLDivElement>(null);
    const dropdownRef = (ref as React.RefObject<HTMLDivElement>) ?? internalRef;

    // Scroll active item into view
    useEffect(() => {
      const el = dropdownRef.current;
      if (!el) return;
      const active = el.querySelector(".autocomplete-active");
      if (active) active.scrollIntoView({ block: "nearest" });
    }, [activeIndex, dropdownRef]);

    if (items.length === 0) return null;

    return (
      <div ref={dropdownRef} className="autocomplete-dropdown">
        {items.map((item, i) => (
          <div
            key={item.key}
            className={`autocomplete-item${i === activeIndex ? " autocomplete-active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(i);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <span className="autocomplete-name">{item.label}</span>
            {item.description && <span className="autocomplete-desc">{item.description}</span>}
          </div>
        ))}
      </div>
    );
  },
);
