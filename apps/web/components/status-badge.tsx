import { Badge } from "@/components/ui";

const STATUS_VARIANT = {
  succeeded: "success",
  failed: "destructive",
  running: "warning",
} as const;

export function StatusBadge({ status }: { status: string }) {
  const variant = STATUS_VARIANT[status as keyof typeof STATUS_VARIANT] ?? "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}
