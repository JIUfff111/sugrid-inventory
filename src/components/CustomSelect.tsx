/**
 * 自定义下拉选择组件
 * 玻璃拟态风格，替代原生 select
 */
'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
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
  'aria-label': ariaLabel,
}: CustomSelectProps) {
  const { active } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => () => { setIsOpen(false); setSearchText(''); }, []);
  useEffect(() => { if (!active) { setIsOpen(false); setSearchText(''); } }, [active]);

  // 获取选中项的标签
  const selectedLabel = options.find(opt => opt.value === value)?.label || placeholder;

  // 过滤选项
  const filteredOptions = searchable && searchText
    ? options.filter(opt => 
        opt.label.toLowerCase().includes(searchText.toLowerCase())
      )
    : options;

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchText('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setSearchText('');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setSearchText('');
  };

  return (
    <div ref={containerRef} className="relative">
      {/* 触发器 */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        data-required={required || undefined}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                   text-left focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary 
                   transition-all flex items-center justify-between
                   ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-white/80'}
                   ${!value ? 'text-ink-soft/50' : 'text-ink'}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown 
          className={`w-4 h-4 text-ink-soft transition-transform flex-shrink-0 ml-2
                     ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* 下拉列表 */}
      {active && isOpen && (
        <div className="dropdown-surface absolute z-50 w-full mt-2 rounded-xl shadow-lg overflow-hidden animate-fade-in">
          {/* 搜索框 */}
          {searchable && (
            <div className="p-2 border-b border-line">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="搜索..."
                  className="w-full pl-9 pr-3 py-2 bg-white/60 border border-line/50 rounded-lg text-[13px]
                           placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                           focus:ring-primary/20 focus:border-primary transition-all"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          )}

          {/* 选项列表 */}
          <div className="max-h-60 overflow-y-auto py-1" role="listbox" aria-label={ariaLabel || placeholder}>
            {filteredOptions.length === 0 ? (
              <div className="px-4 py-3 text-[13px] text-ink-soft text-center">
                无匹配结果
              </div>
            ) : (
              filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  role="option"
                  aria-selected={value === option.value}
                  className={`w-full px-4 py-2.5 text-[13px] text-left transition-all flex items-center justify-between
                             ${value === option.value 
                               ? 'bg-primary/10 text-primary font-medium' 
                               : 'hover:bg-white/40 text-ink'
                             }`}
                >
                  <span className="truncate">{option.label}</span>
                  {value === option.value && (
                    <Check className="w-4 h-4 text-primary flex-shrink-0 ml-2" />
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
