'use client';

import { Activity, createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { SessionUser } from '@/lib/access';

interface WorkspaceValue {
  active: boolean;
  href: string;
  searchParams: URLSearchParams;
  user: SessionUser | null;
  activeRef: { current: boolean };
  ownerActiveRef: { current: boolean };
  setDirty: (source: string, dirty: boolean) => void;
}
const fallbackActiveRef = { current: true };
const fallback: WorkspaceValue = { active: true, href: '/', searchParams: new URLSearchParams(), user: null, activeRef: fallbackActiveRef, ownerActiveRef: fallbackActiveRef, setDirty: () => {} };
const WorkspaceContext = createContext<WorkspaceValue>(fallback);

export function WorkspaceProvider({ active, href, user, setDirty, children }: { active: boolean; href: string; user: SessionUser; setDirty: WorkspaceValue['setDirty']; children: ReactNode }) {
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; }, [active]);
  const searchParams = useMemo(() => new URL(href, 'http://workspace.local').searchParams, [href]);
  const value = useMemo(() => ({ active, href, user, searchParams, activeRef, ownerActiveRef: activeRef, setDirty }), [active, href, user, searchParams, setDirty]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() { return useContext(WorkspaceContext); }

/** Inventory's internal workspaces share the owning tab and dirty registry. */
export function WorkspaceSection({ active, children }: { active: boolean; children: ReactNode }) {
  const parent = useWorkspace();
  const visible = parent.active && active;
  const activeRef = useRef(visible);
  useLayoutEffect(() => { activeRef.current = visible; }, [visible]);
  const value = useMemo(() => ({ ...parent, active: visible, activeRef }), [parent, visible]);
  return <WorkspaceContext.Provider value={value}><Activity mode={visible ? 'visible' : 'hidden'}>{children}</Activity></WorkspaceContext.Provider>;
}

/** Hidden Activities retain their dirty markers; closing their host releases all markers. */
export function useWorkspaceDirty(dirty: boolean) {
  const { setDirty, activeRef, ownerActiveRef } = useWorkspace();
  const source = useId();
  useEffect(() => {
    setDirty(source, dirty);
    return () => { if (activeRef.current && ownerActiveRef.current) setDirty(source, false); };
  }, [activeRef, ownerActiveRef, dirty, setDirty, source]);
}
