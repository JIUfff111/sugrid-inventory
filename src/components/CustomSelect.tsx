/**
 * 自定义下拉选择组件
 * 玻璃拟态风格，替代原生 select
 */
'use client';

import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';
import { useWorkspace } from '@/components/WorkspaceContext';

export interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
  required?: boolean;
  compact?: boolean;
  highlighted?: boolean;
  'aria-label'?: string;
}

export default function CustomSelect({
  value,
  onChange,
  options,
  placeholder = '请选择',
  searchable = false,
  disabled = false,
  required = false,
  compact = false,
  highlighted = false,
  'aria-label': ariaLabel,
}: CustomSelectProps) {
  const { active } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const triggerId = useId();
  const valueId = useId();
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openingEdge = useRef<'first' | 'last' | 'selected'>('selected');
  const open = active && !disabled && isOpen;
  useEffect(() => { if (!active || disabled) { setIsOpen(false); setSearchText(''); } }, [active, disabled]);

  const selectedOption = options.find(opt => opt.value === value);
  const selectedLabel = selectedOption?.label ?? placeholder;

  // 过滤选项
  const filteredOptions = searchable && searchText
    ? options.filter(opt => 
        opt.label.toLowerCase().includes(searchText.toLowerCase())
      )
    : options;

  // A top-layer popup can extend past table and dialog scroll containers while
  // remaining in the dialog's DOM subtree for focus and keyboard handling.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!open || !popup || !trigger || !list) return;

    function position() {
      if (!popup || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = document.documentElement;
      const gap = 6;
      const inset = 8;
      const above = Math.max(0, rect.top - gap - inset);
      const below = Math.max(0, viewport.clientHeight - rect.bottom - gap - inset);
      const placeAbove = below < 248 && above > below;
      const width = Math.min(Math.max(rect.width, compact ? 80 : 168), viewport.clientWidth - inset * 2);
      Object.assign(popup.style, {
        position: 'fixed',
        inset: 'auto',
        margin: '0',
        width: `${width}px`,
        maxHeight: `${placeAbove ? above : below}px`,
        left: `${Math.max(inset, Math.min(rect.left, viewport.clientWidth - inset - width))}px`,
        top: placeAbove ? 'auto' : `${rect.bottom + gap}px`,
        bottom: placeAbove ? `${viewport.clientHeight - rect.top + gap}px` : 'auto',
      });
    }

    if (typeof popup.showPopover === 'function') {
      position();
      popup.showPopover();
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
    }
    const edge = openingEdge.current;
    if (edge === 'selected' && searchRef.current) {
      searchRef.current.focus({ preventScroll: true });
    } else {
      const selector = '[role="option"]';
      const option = edge === 'last'
        ? list.querySelector<HTMLElement>(`${selector}:last-child`)
        : (edge === 'selected' && list.querySelector<HTMLElement>(`${selector}[aria-selected="true"]`))
          || list.querySelector<HTMLElement>(selector);
      focusOption(option || null, list);
    }

    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, compact]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchText('');
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [open]);

  const close = (restoreFocus = false) => {
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
    setIsOpen(false);
    setSearchText('');
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (open && event.target === searchRef.current && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>('[role="option"]')?.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === searchRef.current && (event.key === 'Home' || event.key === 'End')) return;
    if (!open) {
      if (disabled || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
      event.preventDefault();
      openingEdge.current = event.key === 'ArrowUp' ? 'last' : 'first';
      setIsOpen(true);
      return;
    }
    const list = listRef.current;
    if (!list) return;
    event.preventDefault();
    const items = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    const current = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : event.key === 'ArrowDown' ? Math.min(current + 1, last)
      : current < 0 ? last : Math.max(current - 1, 0);
    focusOption(items[next] ?? null, list);
  };

  const triggerTone = highlighted ? 'text-primary' : selectedOption ? 'text-ink' : 'text-ink-soft/50';

  return (
    <div ref={containerRef} className="relative min-w-0" onKeyDown={handleKey} onBlur={event => {
      if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
    }}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        onClick={() => {
          if (open) close();
          else { openingEdge.current = 'selected'; setIsOpen(true); }
        }}
        disabled={disabled}
        data-required={required || undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaLabel ? valueId : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={`field flex w-full items-center justify-between text-left ${compact ? '!px-2 !py-1.5 !text-xs' : ''}
                   motion-reduce:transition-none
                   ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-white/80'}
                   ${triggerTone}`}
      >
        <span id={valueId} className="truncate" title={selectedLabel}>{selectedLabel}</span>
        <ChevronDown aria-hidden="true"
          className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} ml-2 shrink-0 text-ink-soft transition-transform motion-reduce:transition-none
                     ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div ref={popupRef} popover="manual" className="dropdown-surface absolute z-50 mt-2 flex w-full flex-col overflow-hidden rounded-xl shadow-lg motion-safe:animate-fade-in">
          {searchable && (
            <div className="shrink-0 border-b border-line p-2">
              <div className="relative">
                <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                <input
                  ref={searchRef}
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  aria-label="搜索选项"
                  placeholder="搜索..."
                  className="w-full pl-9 pr-3 py-2 bg-white/60 border border-line/50 rounded-lg text-[13px]
                           placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                           focus:ring-primary/20 focus:border-primary transition-all"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          )}

          <div ref={listRef} id={listId} className="relative min-h-0 max-h-60 overflow-y-auto py-1" role="listbox" aria-labelledby={triggerId}>
            {filteredOptions.length === 0 ? (
              <div className="px-4 py-3 text-[13px] text-ink-soft text-center">
                无匹配结果
              </div>
            ) : (
              filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => { close(true); onChange(option.value); }}
                  role="option"
                  tabIndex={-1}
                  aria-selected={value === option.value}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] outline-none transition-colors focus-visible:bg-primary/15 motion-reduce:transition-none
                             ${value === option.value 
                               ? 'bg-primary/10 text-primary font-medium' 
                               : 'text-ink hover:bg-primary/5'
                             }`}
                >
                  <span className="min-w-0 break-words">{option.label}</span>
                  {value === option.value && (
                    <Check aria-hidden="true" className="ml-2 h-4 w-4 shrink-0 text-primary" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function focusOption(option: HTMLElement | null, list: HTMLElement) {
  if (!option) return;
  option.focus({ preventScroll: true });
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}
