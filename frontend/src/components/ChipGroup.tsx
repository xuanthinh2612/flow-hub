import React from 'react';

export interface ChipOption<T = any> {
  value: T;
  label: React.ReactNode;
  hint?: React.ReactNode;
  title?: string;
  isNew?: boolean;
}

interface ChipGroupProps<T> {
  options: ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  toggle?: boolean;
  cls?: string;
}

export function ChipGroup<T>({ options, value, onChange, toggle = false, cls = 'chips' }: ChipGroupProps<T>) {
  return (
    <div className={cls}>
      {options.map((o, idx) => {
        const isActive = String(o.value) === String(value);
        return (
          <button
            key={idx}
            type="button"
            className={`chip${isActive ? ' active' : ''}${o.isNew ? ' new' : ''}`}
            title={o.title || ''}
            onClick={() => {
              const next = (toggle && isActive ? null : o.value) as T;
              onChange(next);
            }}
          >
            {o.label}
            {o.hint && <small>{o.hint}</small>}
          </button>
        );
      })}
    </div>
  );
}

