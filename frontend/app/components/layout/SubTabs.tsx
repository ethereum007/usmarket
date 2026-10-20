"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { PremiumBadge } from "../premium/PremiumBadge";

interface SubTabsProps<T extends string> {
  tabs: { key: T; label: ReactNode; premium?: boolean; href?: string }[];
  active: T;
  onChange?: (tab: T) => void;
}

export function SubTabs<T extends string>({ tabs, active, onChange }: SubTabsProps<T>) {
  return (
    <div className="sub-tabs" role="group" aria-label="View options">
      {tabs.map((tab) => {
        const content = <><span>{tab.label}</span>{tab.premium && <PremiumBadge className="ml-1.5" />}</>;
        const className = cn("sub-tab", active === tab.key && "is-active");
        return tab.href ? (
          <Link key={tab.key} href={tab.href} aria-current={active === tab.key ? "page" : undefined} className={className}>{content}</Link>
        ) : (
          <button key={tab.key} type="button" aria-pressed={active === tab.key} onClick={() => onChange?.(tab.key)} className={className}>{content}</button>
        );
      })}
    </div>
  );
}
