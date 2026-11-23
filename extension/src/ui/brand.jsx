// The brand mark, network colours and the approval window's header and
// action bar. Every colour is a Kumo token.
import { MoonIcon } from '@phosphor-icons/react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Text } from '@cloudflare/kumo/components/text';

/** Brand mark: the moon glyph on brand blue. */
export function Mark({ size = 28 }) {
  const radius = size >= 56 ? 14 : size <= 24 ? 7 : 8;
  return (
    <span className="inline-flex shrink-0 items-center justify-center bg-kumo-brand text-white"
      style={{ width: size, height: size, borderRadius: radius }}>
      <MoonIcon size={size >= 56 ? 32 : Math.round(size * 0.6)} weight="bold" />
    </span>
  );
}

// One color per built-in network, used wherever the network is shown; the
// user's own networks are neutral.
const NETWORK_LOOK = {
  mainnet: { badge: 'blue', dot: 'bg-kumo-badge-blue' },
  preprod: { badge: 'orange', dot: 'bg-kumo-badge-orange' },
  preview: { badge: 'purple', dot: 'bg-kumo-badge-purple' },
  undeployed: { badge: 'teal', dot: 'bg-kumo-badge-teal' },
};
export const networkLook = id => NETWORK_LOOK[id] ?? { badge: 'neutral', dot: 'bg-kumo-badge-neutral' };

export function NetworkBadge({ network, name }) {
  return <Badge variant={networkLook(network).badge}>{name}</Badge>;
}

/** `network` is the network badge or switcher shown next to the name. */
export function AppHeader({ network, children, subtitle }) {
  return (
    <header className="flex items-center justify-between gap-2 border-b border-kumo-hairline bg-kumo-base px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Mark />
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <Text variant="heading" as="h1">mdwa</Text>
            {network}
          </div>
          {subtitle && <Text variant="secondary" size="xs" truncate>{subtitle}</Text>}
        </div>
      </div>
      <div className="flex items-center gap-1.5">{children}</div>
    </header>
  );
}

// Bottom action bar: the positive (blue) action takes the remaining width with
// its label centered; an optional secondary action sits compact on the left.
export function Actions({ secondary, primary }) {
  return (
    <div className="flex items-center gap-2">
      {secondary && <div className="shrink-0 [&>button]:justify-center [&>button]:px-5">{secondary}</div>}
      <div className="min-w-0 flex-1 [&>button]:w-full [&>button]:justify-center">{primary}</div>
    </div>
  );
}
