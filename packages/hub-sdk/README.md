# @maverick-launch/hub-sdk

Node.js client SDK for the Maverick Launch HUB platform.

## Installation

```bash
npm install @maverick-launch/hub-sdk
```

## Usage

```typescript
import { HubClient, HubAuthError } from '@maverick-launch/hub-sdk';

const client = new HubClient({
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  hubUrl: 'https://hub.maverick-launch.com',
});

await client.connect();
```

## Requirements

- Node.js >= 20
- ESM consumer project (`"type": "module"` in package.json)

<!-- TODO-D-DEF-006: TypeScript-only SDK at v1. SDK languages beyond TypeScript not yet decided. -->
