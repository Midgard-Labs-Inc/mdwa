// Receive: the three addresses of this wallet, one at a time, each with a QR
// code, the full address and a sentence on what it is for. A network without
// DUST shows no DUST address.
import { useState } from 'react';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { AddressQR, ActionFooter, NetworkPill, PageHeader, PrimaryButton, Screen, Segmented, Viewport, useCopy } from './components.jsx';
import { hasDust, networkName } from './format.js';
import { ScanStart } from './sync.jsx';

const KINDS = [
  { value: 'unshielded', label: 'Unshielded', about: 'Receives NIGHT and other public tokens. Balances and transfers at this address are visible on the chain.' },
  { value: 'shielded', label: 'Shielded', about: 'Receives private tokens. Amounts and balances at this address stay hidden on the chain.' },
  { value: 'dust', label: 'DUST', about: 'The address other wallets designate DUST generation to. It cannot receive transfers.' },
];

export function Receive({ state, onBack }) {
  const [kind, setKind] = useState('unshielded');
  const [copied, copy] = useCopy();
  const kinds = hasDust(state) ? KINDS : KINDS.filter(k => k.value !== 'dust');
  const current = KINDS.find(k => k.value === kind);
  const address = state.addresses?.[kind];
  return (
    <Screen>
      <PageHeader title="Receive" onBack={onBack} />
      <Viewport gap="gap-3">
        <Segmented label="Address type" options={kinds} value={kind} onChange={setKind} />
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-kumo-hairline bg-kumo-base px-5 py-4">
          <NetworkPill network={state.network} name={networkName(state)} caret={false} />
          {address && <AddressQR value={address} />}
          <p className="w-full text-center font-mono text-xs leading-normal break-all text-kumo-default">{address}</p>
        </div>
        <p className="text-center text-xs leading-normal text-kumo-subtle">{current.about}</p>
        {kind === 'shielded' && <ScanStart state={state} onlyBirthday />}
      </Viewport>
      <ActionFooter primary={(
        <PrimaryButton icon={copied ? CheckIcon : CopyIcon} disabled={!address} onClick={() => copy(address)}>
          {copied ? 'Copied' : 'Copy address'}
        </PrimaryButton>
      )} />
    </Screen>
  );
}
