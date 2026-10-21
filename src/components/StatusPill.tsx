interface StatusPillProps {
  type: "ok" | "warn" | "danger" | "info";
  children: React.ReactNode;
  withDot?: boolean;
  pulse?: boolean;
  className?: string;
}

export function StatusPill({ 
  type, 
  children, 
  withDot = true, 
  pulse = false,
  className = "" 
}: StatusPillProps) {
  return (
    <span className={`status-pill ${type} ${className}`}>
      {withDot && <span className={`status-dot ${pulse ? "pulse" : ""}`} />}
      {children}
    </span>
  );
}
