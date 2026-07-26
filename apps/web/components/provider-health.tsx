"use client";

import { CircleCheck, CircleX, ZapOff } from "lucide-react";
import type { ProviderView } from "@cgw/shared";
import { Badge } from "@/components/ui";

/**
 * Provider health at a glance. The states are ordered by how much they demand
 * attention: disabled (intentional) → circuit open (routing around it) →
 * unhealthy (last probe failed) → healthy → never checked.
 */
export function ProviderHealthBadge({ provider }: { provider: ProviderView }) {
  if (!provider.isActive) return <Badge tone="neutral">Disabled</Badge>;

  if (provider.circuitOpen) {
    return (
      <Badge tone="critical">
        <ZapOff className="h-3 w-3" />
        Circuit open
      </Badge>
    );
  }

  if (provider.lastHealthOk === false) {
    return (
      <Badge tone="warning">
        <CircleX className="h-3 w-3" />
        Unhealthy
      </Badge>
    );
  }

  if (provider.lastHealthOk === true) {
    return (
      <Badge tone="safe">
        <CircleCheck className="h-3 w-3" />
        Healthy
      </Badge>
    );
  }

  return <Badge tone="neutral">Unchecked</Badge>;
}
