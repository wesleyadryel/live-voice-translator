# Security

## API keys

The extension intentionally uses the key supplied by its owner so it can remain free and backendless. Never commit a key to the repository. Create a dedicated OpenAI project key, set a usage limit, and revoke it in OpenAI if the browser profile is compromised.

## Reporting a vulnerability

Do not open a public issue for a suspected secret exposure or security vulnerability. Contact the maintainer privately with a reproduction and affected version.

## Release boundary

This source build is suitable for users who understand that a browser extension can access its own stored key. A commercial distribution should replace long-lived keys in extension storage with short-lived, server-issued client tokens.
