import { cn } from "@/lib/utils";

interface Props {
  active: boolean;
  className?: string;
}

export function StreamCursor({ active, className }: Props) {
  if (!active) return null;

  return (
    <span
      className={cn(
        "inline-block w-2 h-4 bg-primary animate-pulse align-middle ml-0.5 rounded-sm",
        className
      )}
    />
  );
}
