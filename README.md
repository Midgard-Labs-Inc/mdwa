# mdwa

A Midnight wallet as a Chrome (MV3) extension, built on Midnight's wallet SDK.
It talks to a Midnight node and indexer and works on Preview, Preprod, Mainnet,
a local network and networks you add, with one recovery phrase for all of them.

<table>
  <tr>
    <td><img src="docs/screenshots/home.png" width="250" alt="Home with balances"></td>
    <td><img src="docs/screenshots/send.png" width="250" alt="Send"></td>
    <td><img src="docs/screenshots/dust.png" width="250" alt="DUST balance and registration"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/activity.png" width="250" alt="Activity"></td>
    <td><img src="docs/screenshots/token.png" width="250" alt="Naming a custom token"></td>
    <td><img src="docs/screenshots/approve-transaction.png" width="250" alt="Approving a dApp transaction"></td>
  </tr>
</table>

## Features

- Shielded, unshielded and DUST balances, each with its own address.
- Send to several recipients, with a review step. Fees are paid in DUST.
- Register NIGHT for DUST generation.
- Fast sync: a new wallet on Preview syncs in about 7 seconds.
- Proving in the browser (WASM) or through a proof server.
- DApp Connector API 4.1.0, with an approval window for every transaction.
- Local names for custom tokens, checked against the minting contract.
- Unlock once per browser session.

## Quick start

```bash
npm ci
```

```bash
npm run build:extension
```

```bash
npm run helium
```

`npm run helium` opens [Helium](https://helium.computer) with the extension
loaded. For Chrome, load `build/extension` unpacked from `chrome://extensions`.

Preprod and Mainnet go through Blockfrost and need a project id in Settings,
unless you point them at your own node and indexer. The welcome screen's
Connection settings sets the endpoints before you create a wallet.

`npm run dapp` serves a local test dApp for the connector.

## Documentation

- [Technical overview](docs/technical.md)
- [dApp connector](docs/dapp-connector.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
