import {
  useMemo,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { Icon } from "./Icon";
import { statusLabel, t, type Lang } from "./i18n";
import type { OmpModelInfo } from "./types";

interface ModelPickerProps {
  language: Lang;
  models: OmpModelInfo[];
  onChange: (selector: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  role: string;
  value: string;
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/i;

export function splitSelector(selector: string): { base: string; thinking: string | null } {
  const match = selector.match(THINKING_SUFFIX);
  if (!match || match.index === undefined) {
    return { base: selector, thinking: null };
  }
  return {
    base: selector.slice(0, match.index),
    thinking: match[1].toLowerCase(),
  };
}

function selectorForModel(model: OmpModelInfo, current: string): string {
  const { thinking } = splitSelector(current);
  if (thinking && model.thinking.includes(thinking)) {
    return `${model.selector}:${thinking}`;
  }
  return model.selector;
}

export function matchesSelector(model: OmpModelInfo, selector: string): boolean {
  const base = splitSelector(selector).base.toLowerCase();
  return (
    model.selector.toLowerCase() === base ||
    model.id.toLowerCase() === base ||
    `${model.provider}/${model.id}`.toLowerCase() === base
  );
}

export function ModelPicker({
  language,
  models,
  onChange,
  onOpenChange,
  open,
  role,
  value,
}: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const panelId = `model-picker-${role.replace(/[^a-z0-9_-]/gi, "-")}`;
  const selectedModel = models.find((model) => matchesSelector(model, value));
  const selectedStatus = selectedModel?.status ?? (value ? "missing" : "unset");

  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...models]
      .sort((left, right) => {
        if (left.available !== right.available) {
          return left.available ? -1 : 1;
        }
        return `${left.provider}/${left.name}`.localeCompare(
          `${right.provider}/${right.name}`,
        );
      })
      .filter((model) => {
        if (!normalized) return true;
        return [model.name, model.provider, model.id, model.selector]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      });
  }, [models, query]);

  const setOpen = (next: boolean) => {
    if (!next) setQuery("");
    onOpenChange(next);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) {
      setOpen(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className={`model-picker${open ? " is-open" : ""}`}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="model-picker-trigger"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        type="button"
      >
        <span className="model-picker-copy">
          <strong>
            {selectedModel?.name ?? (value ? t(language, "customModel") : t(language, "statusUnset"))}
          </strong>
          <small>{value || t(language, "statusUnset")}</small>
        </span>
        <span className={`model-picker-status is-${selectedStatus}`}>
          {statusLabel(language, selectedStatus)}
        </span>
        <Icon className="model-picker-chevron" name="chevron" size={15} />
      </button>

      {open && (
        <div className="model-picker-panel" id={panelId}>
          <label className="model-picker-search">
            <Icon name="search" size={14} />
            <input
              aria-label={t(language, "searchModels")}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(language, "searchModelsPlaceholder")}
              spellCheck={false}
              value={query}
            />
          </label>

          <div
            aria-label={t(language, "chooseModel")}
            className="model-picker-options"
            role="listbox"
          >
            {filteredModels.map((model) => {
              const selected = matchesSelector(model, value);
              return (
                <button
                  aria-selected={selected}
                  className={`model-picker-option${selected ? " is-selected" : ""}`}
                  key={model.selector}
                  onClick={() => {
                    onChange(selectorForModel(model, value));
                    setOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.selector}</small>
                  </span>
                  <span className={`model-picker-option-status is-${model.status}`}>
                    {statusLabel(language, model.status)}
                  </span>
                </button>
              );
            })}
            {filteredModels.length === 0 && (
              <div className="model-picker-empty">{t(language, "noModelsFound")}</div>
            )}
          </div>

          <div className="model-picker-manual">
            <label htmlFor={`${panelId}-manual`}>{t(language, "manualSelector")}</label>
            <div>
              <input
                id={`${panelId}-manual`}
                onChange={(event) => onChange(event.target.value)}
                placeholder="provider/model-id[:thinking]"
                spellCheck={false}
                value={value}
              />
              <button className="button secondary" onClick={() => setOpen(false)} type="button">
                {t(language, "done")}
              </button>
            </div>
            <p>{t(language, "manualSelectorHelp")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
